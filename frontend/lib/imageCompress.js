/**
 * @file imageCompress.js
 * @description Shrinks a phone photo in the browser before upload: phone
 * cameras produce 3-8MB files, which are slow on a weak depot connection and
 * wasteful to store. Resizes to a max long edge and re-encodes as JPEG.
 */

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.75;

/**
 * @param {File} file - Image chosen or captured by the user
 * @returns {Promise<File>} A compressed JPEG File
 */
export async function compressImage(file) {
  let bitmap;
  try {
    // 'from-image' applies the EXIF orientation so portrait phone photos
    // are not saved sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`"${file.name}" could not be read as an image (HEIC/HEIF is not supported -- use JPEG, PNG or WebP)`);
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('Could not compress the photo');
  return new File([blob], `tyre-${Date.now()}.jpg`, { type: 'image/jpeg' });
}
