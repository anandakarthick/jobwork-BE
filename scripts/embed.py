"""
Text embeddings for the price-list search (pgvector) — local, no API, no cost.

Runs a small ONNX embedding model (fastembed) on this machine. The model is
downloaded once into backend/.cache/fastembed and reused.

Usage:  py -3 embed.py < request.json > response.json
Request:  {"model": "BAAI/bge-base-en-v1.5", "kind": "passage" | "query", "texts": [str, ...]}
Response: {"model": str, "dim": N, "vectors": [[float, ...], ...]}   (unit length)
"""
import json
import os
import sys
import warnings

# Quiet download chatter (progress bars, Windows symlink notice) — stderr stays readable.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
warnings.filterwarnings("ignore")

from fastembed import TextEmbedding  # noqa: E402

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cache", "fastembed")


def main() -> None:
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    model_name = req.get("model") or "BAAI/bge-base-en-v1.5"
    texts = [str(t) for t in req.get("texts") or []]
    model = TextEmbedding(model_name=model_name, cache_dir=CACHE_DIR)
    if req.get("kind") == "query":
        vectors = list(model.query_embed(texts))
    else:
        vectors = list(model.passage_embed(texts, batch_size=32))
    out = {
        "model": model_name,
        "dim": len(vectors[0]) if vectors else 0,
        "vectors": [[round(float(x), 6) for x in v] for v in vectors],
    }
    sys.stdout.write(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
