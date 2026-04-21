/**
 * 로컬 transformers.js 기반 임베딩 provider.
 * API 호출 없이 Xenova/multilingual-e5-small 등 HuggingFace 모델을 로컬에서 실행.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 */

import { pipeline }    from "@huggingface/transformers";
import { normalizeL2 } from "../tools/embedding.js";

/** 모델 싱글톤 캐시 (modelId → LocalTransformersEmbedder) */
const _singletons = new Map();

export class LocalTransformersEmbedder {
  constructor({ modelId, dimensions }) {
    this.modelId    = modelId;
    this.dimensions = dimensions;
    this._pipeline  = null;
  }

  async init() {
    if (this._pipeline) return;
    console.info(`[LocalEmbedder] loading model ${this.modelId} (dtype=q8)`);
    this._pipeline = await pipeline("feature-extraction", this.modelId, {
      dtype: "q8"
    });
    console.info(`[LocalEmbedder] model ready`);
  }

  /**
   * 단일 텍스트 임베딩 생성
   *
   * @param {string} text
   * @returns {Promise<number[]>} L2 정규화된 임베딩 벡터
   */
  async embed(text) {
    await this.init();
    const output = await this._pipeline(text, { pooling: "mean", normalize: true });
    const vec    = Array.from(output.data);
    if (vec.length !== this.dimensions) {
      throw new Error(`Embedding dim mismatch: expected ${this.dimensions}, got ${vec.length}`);
    }
    return normalizeL2(vec);
  }
}

/**
 * 동일 modelId에 대한 싱글톤 인스턴스 반환
 *
 * @param {string} modelId
 * @param {number} dimensions
 * @returns {LocalTransformersEmbedder}
 */
export function getLocalEmbedder(modelId, dimensions) {
  if (!_singletons.has(modelId)) {
    _singletons.set(modelId, new LocalTransformersEmbedder({ modelId, dimensions }));
  }
  return _singletons.get(modelId);
}
