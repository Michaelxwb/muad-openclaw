import { GlobalModelPanel } from "../components/llm/GlobalModelPanel";
import { PodModelPanel } from "../components/llm/PodModelPanel";
import { useGlobalModel } from "../components/llm/useGlobalModel";
import { usePodModels } from "../components/llm/usePodModels";
import { PageHeader } from "../components/ConsolePage";

export function LLM() {
  const global = useGlobalModel();
  const pods = usePodModels(Boolean(global.config?.configured));
  return (
    <div>
      <PageHeader title="模型配置" description="管理全局模型凭证以及 Pod 级模型覆写" />
      <GlobalModelPanel state={global} />
      <PodModelPanel state={pods} />
    </div>
  );
}
