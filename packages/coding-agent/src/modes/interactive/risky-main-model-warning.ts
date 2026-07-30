import type { Model } from "@earendil-works/pi-ai";

export const RISKY_MAIN_MODEL_WARNING =
	"권장하지 않는 모델입니다. 사용자의 컴퓨터를 훼손할 수 있는 등 위험한 동작을 할 수 있고 테스트되지 않았습니다. 다른 모델을 사용해주세요.";

const RISKY_MODEL_FAMILIES = ["minimax", "qwen"];

/** Matches the model fields shown to users on Senpi's main-model selection surfaces. */
export function isRiskyMainModel(model: Pick<Model<any>, "id" | "name" | "provider">): boolean {
	const searchableLabel = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
	return RISKY_MODEL_FAMILIES.some((family) => searchableLabel.includes(family));
}
