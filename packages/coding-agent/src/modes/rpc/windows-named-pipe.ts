import { type ChildProcess, spawn } from "node:child_process";
import type { Server } from "node:net";

const PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * Listen on a Windows named pipe created with a current-user-only DACL.
 *
 * Node/libuv creates named pipes with a NULL security descriptor, so its
 * readableAll/writableAll flags cannot establish an ACL boundary. A small
 * Windows PowerShell-hosted C# broker owns every pipe instance with an explicit
 * SECURITY_ATTRIBUTES descriptor and byte-proxies accepted connections to a
 * loopback-only Node listener.
 */
export async function listenSecureWindowsPipe(server: Server, address: string): Promise<void> {
	if (process.platform !== "win32") throw new Error("secure Windows named-pipe listener requires win32");
	if (!address.toLowerCase().startsWith(PIPE_PREFIX))
		throw new Error(`invalid Windows named-pipe address: ${address}`);

	const port = await listenLoopback(server);
	const broker = spawn(
		"powershell.exe",
		["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedBroker(address, port)],
		{
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	try {
		await waitForBroker(broker, address);
	} catch (error: unknown) {
		await closeServer(server);
		throw error;
	}
	server.once("close", () => broker.kill());
	broker.once("exit", (code, signal) => {
		if (server.listening) server.emit("error", new Error(`Windows named-pipe broker exited (${code ?? signal})`));
	});
}

function listenLoopback(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			const address = server.address();
			if (typeof address === "object" && address !== null) resolve(address.port);
			else reject(new Error("failed to resolve Windows named-pipe broker loopback port"));
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function waitForBroker(broker: ChildProcess, address: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const cleanup = (): void => {
			broker.stdout?.removeAllListeners();
			broker.stderr?.removeAllListeners();
			broker.off("error", onError);
			broker.off("exit", onExit);
		};
		const fail = (message: string): void => {
			cleanup();
			broker.kill();
			reject(new Error(`${address}: ${message}${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
		};
		const onError = (error: Error): void => fail(`failed to start secure named-pipe broker: ${error.message}`);
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
			fail(`secure named-pipe broker exited before listening (${code ?? signal})`);
		broker.once("error", onError);
		broker.once("exit", onExit);
		broker.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		broker.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			if (!stdout.split(/\r?\n/).includes("READY")) return;
			cleanup();
			resolve();
		});
	});
}

function encodedBroker(address: string, port: number): string {
	const pipeName = address.slice(PIPE_PREFIX.length);
	const script = `$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class SenpiSecurePipeBroker {
  const uint PIPE_ACCESS_DUPLEX = 0x00000003;
  const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
  const uint PIPE_TYPE_BYTE = 0;
  const uint PIPE_READMODE_BYTE = 0;
  const uint PIPE_WAIT = 0;
  const uint PIPE_UNLIMITED_INSTANCES = 255;
  const uint SECURITY_SQOS_PRESENT = 0x00100000;
  const uint SECURITY_IDENTIFICATION = 0x00010000;
  const int ERROR_PIPE_CONNECTED = 535;
  static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public int bInheritHandle;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBufferSize, uint inBufferSize, uint timeout, ref SECURITY_ATTRIBUTES attributes);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ConnectNamedPipe(SafePipeHandle pipe, IntPtr overlapped);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  static string pipeName;
  static int port;
  static IntPtr descriptor;

  public static void Run(string name, int targetPort) {
    pipeName = name;
    port = targetPort;
    string sid = WindowsIdentity.GetCurrent().User.Value;
    uint descriptorSize;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;" + sid + ")", 1, out descriptor, out descriptorSize))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    StartInstance(true);
    Thread.Sleep(Timeout.Infinite);
  }

  static void StartInstance(bool first) {
    var attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = descriptor, bInheritHandle = 0 };
    uint openMode = PIPE_ACCESS_DUPLEX | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
    IntPtr raw = CreateNamedPipe(@"\\.pipe" + pipeName, openMode, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, ref attributes);
    if (raw == INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error());
    var handle = new SafePipeHandle(raw, true);
    new Thread(() => Proxy(handle)) { IsBackground = true }.Start();
    if (first) { Console.WriteLine("READY"); Console.Out.Flush(); }
  }

  static void Proxy(SafePipeHandle handle) {
    try {
      if (!ConnectNamedPipe(handle, IntPtr.Zero) && Marshal.GetLastWin32Error() != ERROR_PIPE_CONNECTED) throw new Win32Exception(Marshal.GetLastWin32Error());
      StartInstance(false);
      using (handle)
      using (var pipe = new FileStream(handle, FileAccess.ReadWrite, 65536, false))
      using (var tcp = new TcpClient("127.0.0.1", port)) {
        var network = tcp.GetStream();
        var toTcp = pipe.CopyToAsync(network);
        var toPipe = network.CopyToAsync(pipe);
        System.Threading.Tasks.Task.WaitAny(toTcp, toPipe);
      }
    } catch { handle.Dispose(); }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[SenpiSecurePipeBroker]::Run(${powershellString(pipeName)}, ${port})`;
	return Buffer.from(script, "utf16le").toString("base64");
}

function powershellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
