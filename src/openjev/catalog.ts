export type OpenJevBackendId = "vllm" | "mlx" | "laya" | "verdict" | "clm" | "jevk5" | "clef" | "clef-flash";

export interface OpenJevModel {
  id: string;
  aliases: string[];
  name: string;
  origin: string;
  size: string;
  input: string;
  maxChoices: number;
  hardware: string;
  hardwareTags: Array<"nvidia" | "nvidia-blackwell" | "apple-silicon" | "cpu">;
  easeOfRun: number;
  backend: OpenJevBackendId;
  envModel?: string;
  dockerProfile?: string;
}

export const OPENJEV_MODELS: OpenJevModel[] = [
  {
    id: "openjev-latest",
    aliases: ["openjev-0.1", "jev-latest", "jev-preview"],
    name: "OpenJev latest",
    origin: "DiffusionGemma 26B-A4B (NVIDIA / Google), read as a diffusion canvas",
    size: "26B total, 4B active",
    input: "text and images",
    maxChoices: 255,
    hardware: "NVIDIA GPU with 24 GB+ VRAM, or Apple silicon with ~16 GB free",
    hardwareTags: ["nvidia", "apple-silicon"],
    easeOfRun: 5,
    backend: "vllm",
    envModel: "nvidia/diffusiongemma-26B-A4B-it-NVFP4",
  },
  {
    id: "laya-1.0",
    aliases: [],
    name: "Laya",
    origin: "Laya by Nandakishor M / Convai Innovations",
    size: "421M",
    input: "text, 1,024 tokens",
    maxChoices: 255,
    hardware: "Any PyTorch device: NVIDIA GPU or CPU",
    hardwareTags: ["nvidia", "cpu"],
    easeOfRun: 10,
    backend: "laya",
  },
  {
    id: "verdict-1.4",
    aliases: [],
    name: "Verdict",
    origin: "Verdict by Heman10x (ModernBERT + GLiClass head)",
    size: "151M",
    input: "text, 512 tokens",
    maxChoices: 24,
    hardware: "Any PyTorch device: NVIDIA GPU or CPU",
    hardwareTags: ["nvidia", "cpu"],
    easeOfRun: 10,
    backend: "verdict",
  },
  {
    id: "clm-v0.1",
    aliases: [],
    name: "CLM",
    origin: "Contrastive-LM: contrastive heads over Qwen3-8B",
    size: "8B + 2 x 9.4M",
    input: "text, 2,048 tokens",
    maxChoices: 255,
    hardware: "NVIDIA GPU (vLLM), ~16 GB VRAM",
    hardwareTags: ["nvidia"],
    easeOfRun: 4,
    backend: "clm",
    dockerProfile: "clm",
  },
  {
    id: "jevk5-0.3",
    aliases: [],
    name: "JevK5",
    origin: "JevK5 by Alibi Serikbay: Qwen3.5-4B with a distilled LoRA",
    size: "4B",
    input: "text, 16,384 tokens",
    maxChoices: 255,
    hardware: "NVIDIA GPU (vLLM), ~8 GB VRAM",
    hardwareTags: ["nvidia"],
    easeOfRun: 6,
    backend: "jevk5",
    envModel: "alibiserikbay/JevK5",
    dockerProfile: "jevk5",
  },
  {
    id: "clef-1.0",
    aliases: [],
    name: "Clef",
    origin: "Clef by Cloudflare: Qwen3.8-27B with a joint schema head, NVFP4",
    size: "27B",
    input: "text and images, 16,384 tokens",
    maxChoices: 255,
    hardware: "NVIDIA Blackwell GPU (RTX 50 / Pro), ~23 GB VRAM",
    hardwareTags: ["nvidia-blackwell"],
    easeOfRun: 3,
    backend: "clef",
    envModel: "simonlehmann/clef-NVFP4",
    dockerProfile: "clef",
  },
  {
    id: "clef-flash-1.0",
    aliases: [],
    name: "Clef-flash",
    origin: "Clef-flash by Cloudflare: Clef on Qwen3.5-9B, NVFP4",
    size: "9B",
    input: "text and images, 16,384 tokens",
    maxChoices: 255,
    hardware: "NVIDIA Blackwell GPU (RTX 50 / Pro), ~12 GB VRAM",
    hardwareTags: ["nvidia-blackwell"],
    easeOfRun: 6,
    backend: "clef-flash",
    envModel: "alpha-x-ai/clef-flash-NVFP4",
    dockerProfile: "clef",
  },
];

export const DEFAULT_OPENJEV_MODEL = "openjev-latest";

export function findModel(id: string): OpenJevModel | undefined {
  const normalized = id.trim().toLowerCase();
  return OPENJEV_MODELS.find(
    (model) => model.id.toLowerCase() === normalized || model.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
}

/**
 * Renders a model the way the launcher shows it, e.g.
 * `clef-flash-1.0 (Supports: NVIDIA Blackwell GPU (RTX 50 / Pro), ~12 GB VRAM, 6/10)`.
 */
export function formatModelLine(model: OpenJevModel): string {
  return `${model.id} (Supports: ${model.hardware}, ${model.easeOfRun}/10)`;
}

export function formatModelDetail(model: OpenJevModel): string {
  return `${formatModelLine(model)}\n      ${model.name} - ${model.origin}\n      size ${model.size}; ${model.input}; up to ${model.maxChoices} choices`;
}

/** Model label for a hosted server (Codiv): no hardware or ease-of-run framing. */
export function formatHostedModelLine(model: OpenJevModel): string {
  return `${model.id}  (${model.name})`;
}

export interface HardwareCaps {
  nvidia: boolean;
  nvidiaBlackwell: boolean;
  appleSilicon: boolean;
  cpu: boolean;
  vramGb: number | null;
}

export function supportsHardware(model: OpenJevModel, caps: HardwareCaps): boolean {
  return model.hardwareTags.some((tag) => {
    if (tag === "cpu") return caps.cpu;
    if (tag === "nvidia") return caps.nvidia;
    if (tag === "nvidia-blackwell") return caps.nvidiaBlackwell;
    if (tag === "apple-silicon") return caps.appleSilicon;
    return false;
  });
}
