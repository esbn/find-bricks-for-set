import { segmentLocal } from "./engine/segmentation-client.mjs";

// Preserve the established working-photo decoder and its coordinate contract.
// Only YOLO mode sends the retained full-resolution source to the local worker.
export async function segmentTiled(working, source, options) {
  options.onProgress?.({ phase: "encoding", message: `Preparing ${source.width} × ${source.height} source photo for local tiled detection…` });
  const blob = await new Promise((resolve) => source.toBlob(resolve, "image/jpeg", .95));
  if (!blob) throw Error("Could not encode the full-resolution source photo.");
  if (blob.size > 40 * 1024 * 1024) throw Error("Source photo exceeds the 40 MB inference limit. Use a smaller photo.");
  const sourceImage = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(Error("Could not read the source photo."));
    reader.readAsDataURL(blob);
  });
  const result = await segmentLocal(working, {
    ...options,
    fetcher: (url, request) => fetch(url, {
      ...request,
      body: JSON.stringify({ ...JSON.parse(request.body), sourceImage, tiled: true }),
    }),
  });
  if (result.tiling?.sourceWidth !== source.width || result.tiling?.sourceHeight !== source.height)
    throw Error("The backend did not process the source-resolution tiles. Restart the app server, refresh, re-upload the photo and identify again.");
  return result;
}
