/**
 * SEOCoral fork: the weak-passage cut-off, kept in its own dependency-free module so the audit
 * checks can read it without loading the reranker (and the ONNX runtime) at import time.
 * Upstream calibrated 3 for the English ms-marco model; the multilingual default may need a
 * different value. Override with SAC_WEAK_PASSAGE_THRESHOLD after checking real pages.
 */
const raw = (process.env.SAC_WEAK_PASSAGE_THRESHOLD ?? '').trim();
export const WEAK_PASSAGE_THRESHOLD: number = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : 3;
