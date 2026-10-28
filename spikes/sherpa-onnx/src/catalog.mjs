/**
 * Candidate sherpa-onnx models for Natively's local STT.
 *
 * Every entry was checked against the Hugging Face repo listing (files + byte
 * sizes) on 2026-10-28. Files live flat in the repo (no `onnx/` subdir), which
 * is why sherpa needs its own download provider rather than the existing
 * transformers.js cache layout.
 *
 * `kind`:
 *   'online-transducer'  streaming zipformer (encoder/decoder/joiner)
 *   'online-paraformer'  streaming paraformer (encoder/decoder)
 *   'offline-sensevoice' SenseVoice (single session, 5 languages + emotion)
 *   'offline-paraformer' single session paraformer
 *
 * `langs` is what the model card / sherpa docs document, not a guess.
 */

export const MODELS = [
  {
    id: 'zipformer-zh-streaming',
    kind: 'online-transducer',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
    files: [
      'encoder.int8.onnx',
      'decoder.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
      'test_wavs/0.wav',
      'test_wavs/1.wav',
    ],
    langs: ['zh'],
    note: 'Chinese-only streaming zipformer, 2025-06 release (int8, 167MB)',
  },
  {
    id: 'zipformer-zh-en-streaming',
    kind: 'online-transducer',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    files: [
      'encoder-epoch-99-avg-1.int8.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.int8.onnx',
      'tokens.txt',
      'bpe.model',
      'test_wavs/0.wav',
      'test_wavs/3.wav',
    ],
    langs: ['zh', 'en'],
    note: 'Bilingual zh-en streaming, the classic sherpa baseline (int8, 202MB)',
  },
  {
    id: 'paraformer-zh-yue-en-streaming',
    kind: 'online-paraformer',
    repo: 'csukuangfj/sherpa-onnx-streaming-paraformer-trilingual-zh-cantonese-en',
    files: [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'tokens.txt',
      'test_wavs/1.wav',
      'test_wavs/2.wav',
      'test_wavs/6-zh-en.wav',
    ],
    langs: ['zh', 'yue', 'en'],
    note: 'Streaming paraformer, Mandarin + Cantonese + English code-switching (int8, 238MB)',
  },
  {
    id: 'zipformer-ctc-zh-streaming',
    kind: 'online-ctc',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-ctc-zh-int8-2025-06-30',
    files: ['model.int8.onnx', 'tokens.txt', 'test_wavs/0.wav', 'test_wavs/1.wav'],
    langs: ['zh'],
    note: 'Chinese streaming zipformer-CTC, one session, 2025-06 (int8, 163MB)',
  },
  {
    id: 'zipformer-multi-zh-hans-streaming',
    kind: 'online-transducer',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13',
    files: [
      'encoder-epoch-20-avg-1-chunk-16-left-128.int8.onnx',
      'decoder-epoch-20-avg-1-chunk-16-left-128.onnx',
      'joiner-epoch-20-avg-1-chunk-16-left-128.int8.onnx',
      'bpe.model',
      'tokens.txt',
      'test_wavs/TEST_MEETING_T0000000219.wav',
      'test_wavs/DEV_T0000000000.wav',
      'test_wavs/TEST_MEETING_T0000000113.wav',
    ],
    langs: ['zh', 'zh-hans dialects'],
    note: 'Multi-dialect Mandarin streaming, 77MB total, ships real MEETING fixtures',
  },
  {
    id: 'zipformer-8lang-streaming',
    kind: 'online-transducer',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10',
    files: [
      'encoder-epoch-75-avg-11-chunk-16-left-128.int8.onnx',
      'decoder-epoch-75-avg-11-chunk-16-left-128.onnx',
      'joiner-epoch-75-avg-11-chunk-16-left-128.int8.onnx',
      'bpe.model',
      'tokens.txt',
      'test_wavs/zh.wav',
      'test_wavs/ja.wav',
      'test_wavs/en.wav',
    ],
    langs: ['ar', 'en', 'id', 'ja', 'ru', 'th', 'vi', 'zh'],
    note: 'One streaming model, 8 languages incl. Chinese and Japanese (340MB)',
  },
  {
    id: 'paraformer-zh-2025',
    kind: 'offline-paraformer',
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-int8-2025-10-07',
    files: ['model.int8.onnx', 'tokens.txt', 'test_wavs/1.wav', 'test_wavs/5.wav', 'test_wavs/9.wav'],
    langs: ['zh'],
    note: 'Newest Chinese paraformer (2025-10), int8 238MB',
  },
  {
    id: 'sensevoice-2025',
    kind: 'offline-sensevoice',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    files: ['model.int8.onnx', 'tokens.txt', 'test_wavs/yue-1.wav'],
    langs: ['zh', 'yue', 'en', 'ja', 'ko'],
    note: 'SenseVoice 2025-09 refresh, int8 237MB',
  },
  {
    id: 'sensevoice-zh-en-ja-ko-yue',
    kind: 'offline-sensevoice',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    files: [
      'model.int8.onnx',
      'tokens.txt',
      'test_wavs/zh.wav',
      'test_wavs/yue.wav',
      'test_wavs/en.wav',
      'test_wavs/ja.wav',
      'test_wavs/ko.wav',
    ],
    langs: ['zh', 'yue', 'en', 'ja', 'ko'],
    note: 'Non-streaming SenseVoice: 5 languages, emotion + event tags (int8, 239MB)',
  },
  {
    id: 'paraformer-zh',
    kind: 'offline-paraformer',
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09',
    files: [
      'model.int8.onnx',
      'tokens.txt',
      'test_wavs/0.wav',
      'test_wavs/1.wav',
      'test_wavs/2-zh-en.wav',
      'test_wavs/3-sichuan.wav',
      'test_wavs/4-tianjin.wav',
      'test_wavs/5-henan.wav',
    ],
    langs: ['zh'],
    note: 'Non-streaming paraformer with accented Mandarin test audio (Sichuan/Tianjin/Henan) (int8, 227MB)',
  },
  {
    id: 'paraformer-zh-yue-en',
    kind: 'offline-paraformer',
    repo: 'csukuangfj/sherpa-onnx-paraformer-trilingual-zh-cantonese-en',
    files: [
      'model.int8.onnx',
      'tokens.txt',
      'test_wavs/1.wav',
      'test_wavs/2.wav',
      'test_wavs/6-zh-en.wav',
    ],
    langs: ['zh', 'yue', 'en'],
    note: 'Non-streaming trilingual paraformer (int8, 245MB)',
  },
];

/** Chinese/English punctuation restoration (CT-Transformer). Local path has none today. */
export const PUNCT_MODEL = {
  id: 'punct-zh-en',
  repo: 'csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12',
  files: ['model.onnx', 'tokens.json'],
  note: 'Adds ，。？！ to unpunctuated CTC/paraformer output (294MB fp32)',
};

export function modelById(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) {
    throw new Error(`unknown model "${id}" — known: ${MODELS.map((x) => x.id).join(', ')}`);
  }
  return m;
}
