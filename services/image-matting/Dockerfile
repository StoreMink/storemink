# Image-matting service: Node + onnxruntime-node (CPU) + one BiRefNet model.
# See docs/image-matting-service.md. Built from this directory:
#   docker build -t image-matting services/image-matting
# The default model is BiRefNet lite (Swin-Tiny, 224 MB). For the full model:
#   --build-arg MODEL_NAME=birefnet-full \
#   --build-arg MODEL_URL=https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-epoch_244.onnx \
#   --build-arg MODEL_SHA256=58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c

# Stage 1: the model, refused unless its SHA-256 matches the pinned value.
FROM node:24-slim AS model
ARG MODEL_URL=https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx
ARG MODEL_SHA256=5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333
WORKDIR /fetch
COPY fetch-model.mjs ./
RUN node fetch-model.mjs "$MODEL_URL" "$MODEL_SHA256" /models/birefnet.onnx

# Stage 2: the service.
FROM node:24-slim
# onnxruntime-node bundles its CPU libraries; skip its optional CUDA download.
# ★ ONNX Runtime 1.30's Linux build carries Microsoft's telemetry client
# ("Telemetry system created" in its log). It never sees a photo, but this
# service has no business phoning anywhere, so it is switched off rather than
# left to fail on the missing CA bundle, which is what silenced it at first.
ENV NODE_ENV=production \
    ONNXRUNTIME_NODE_INSTALL=skip \
    ORT_DISABLE_TELEMETRY=1
WORKDIR /app
COPY package.json package-lock.json ./
# The macOS and Windows libraries onnxruntime-node also ships are dead weight
# in a Linux image.
RUN npm ci --omit=dev --no-audit --no-fund \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin \
            node_modules/onnxruntime-node/bin/napi-v*/win32
COPY matting-core.mjs server.mjs ./
COPY --from=model /models /models

ARG MODEL_NAME=birefnet-lite
ENV MATTING_MODEL_PATH=/models/birefnet.onnx \
    MATTING_MODEL_NAME=$MODEL_NAME \
    PORT=8080

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
