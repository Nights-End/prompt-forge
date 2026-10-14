// Wan2.2 I2V 负向提示词:与 2026-10-12 手动提交的 15 号工作流逐字一致,勿改。
export const DEFAULT_NEGATIVE_PROMPT =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

export const POLL_INTERVAL_MS = 5_000;
export const STALE_PENDING_MS = 60 * 60 * 1000; // 1h:重启对账时,missing 且超龄的 pending → failed
export const MAX_ACTIVE_JOBS = 3; // 同一 ComfyUI 上并行的 forge 视频任务上限(每个 ~13 分钟)

type ComfyNode = { class_type: string; inputs: Record<string, unknown> };
export type ComfyPromptGraph = Record<string, ComfyNode>;

// 15 号工作流(Wan2.2 GGUF I2V,Dasiwa Q4 H/L + umt5 Q4,4步/cfg1/euler,
// 480x848@49帧=3秒,BlockSwap10)的 API 图模板。2026-10-12 实测 13:08 出片。
// 占位符:{{image}} {{prompt}} {{negative}} {{seed}} {{prefix}}
const TEMPLATE: ComfyPromptGraph = {
  '30': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'Wan2.2\\I2V\\Wan2.2_I2V_Dasiwa-V10_Q4_High.gguf' } },
  '31': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'Wan2.2\\I2V\\Wan2.2_I2V_Dasiwa-V10_Q4_Low.gguf' } },
  '32': { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: 'Wan2.2\\umt5-xxl-encoder-Q4_K_M.gguf', type: 'wan' } },
  '9': { class_type: 'VAELoader', inputs: { vae_name: 'Wan2.2\\wan_2.1_vae.safetensors' } },
  '23': { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  '44': { class_type: 'PrimitiveStringMultiline', inputs: { value: '{{prompt}}' } },
  '18': { class_type: 'CLIPTextEncode', inputs: { clip: '32', text: '{{negative}}' } },
  '29': { class_type: 'CLIPTextEncode', inputs: { clip: '32', text: '{{prompt}}' } },
  '16': { class_type: 'PathchSageAttentionKJ', inputs: { model: '30', sage_attention: 'sageattn_qk_int8_pv_fp16_triton', allow_compile: false } },
  '17': { class_type: 'PathchSageAttentionKJ', inputs: { model: '31', sage_attention: 'sageattn_qk_int8_pv_fp16_triton', allow_compile: false } },
  '4': { class_type: 'ModelSamplingSD3', inputs: { model: '16', shift: 5.0 } },
  '15': { class_type: 'ModelSamplingSD3', inputs: { model: '17', shift: 5.0 } },
  '26': { class_type: 'XB_UNetBlockSwap', inputs: { unet_model: '15', blocks_to_swap: 10 } },
  '25': { class_type: 'XB_UNetBlockSwap', inputs: { unet_model: '4', blocks_to_swap: 10 } },
  '27': { class_type: 'XB_WanImageToVideo', inputs: { positive: '29', negative: '18', vae: '9', start_image: '23', width: 480, height: 848, length: 49, batch_size: 1, vae_tile_size: 320, scale_method: 'lanczos', crop_mode: 'center' } },
  '20': { class_type: 'KSamplerAdvanced', inputs: { model: '26', positive: '27', negative: '27', latent_image: '27', add_noise: 'enable', noise_seed: '{{seed}}', steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'normal', start_at_step: 0, end_at_step: 2, return_with_leftover_noise: 'enable' } },
  '24': { class_type: 'KSamplerAdvanced', inputs: { model: '25', positive: '27', negative: '27', latent_image: '20', add_noise: 'disable', noise_seed: 0, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'normal', start_at_step: 2, end_at_step: 4, return_with_leftover_noise: 'disable' } },
  '21': { class_type: 'VAEDecodeTiled', inputs: { samples: '24', vae: '9', tile_size: 320, overlap: 32, temporal_size: 84, temporal_overlap: 8 } },
  '22': { class_type: 'VHS_VideoCombine', inputs: { images: '21', frame_rate: 16, loop_count: 0, filename_prefix: '{{prefix}}', format: 'video/h264-mp4', pingpong: false, save_output: true, pix_fmt: 'yuv420p', crf: 15, save_metadata: false, trim_to_audio: false } },
};

export function buildI2vGraph(opts: {
  image: string;
  prompt: string;
  seed: number;
  prefix: string;
  negative?: string;
}): ComfyPromptGraph {
  const graph = JSON.parse(JSON.stringify(TEMPLATE)) as ComfyPromptGraph;
  const fill = (v: unknown) => {
    if (typeof v !== 'string') return v;
    return v
      .replaceAll('{{image}}', opts.image)
      .replaceAll('{{prompt}}', opts.prompt)
      .replaceAll('{{negative}}', opts.negative ?? DEFAULT_NEGATIVE_PROMPT)
      .replaceAll('{{seed}}', String(opts.seed))
      .replaceAll('{{prefix}}', opts.prefix);
  };
  for (const node of Object.values(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      node.inputs[k] = fill(v);
    }
  }
  return graph;
}
