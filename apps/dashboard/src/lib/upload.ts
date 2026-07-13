// Image upload abstraction
// To switch to VPS/local storage: replace uploadImage() only — nothing else changes

const CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string;
const UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string;

export type UploadProvider = 'cloudinary' | 'local';

// Change this to 'local' when moving to VPS
const PROVIDER: UploadProvider = 'cloudinary';

export async function uploadImage(file: File): Promise<string> {
  if (PROVIDER === 'cloudinary') {
    return uploadToCloudinary(file);
  }
  // VPS fallback — implement when self-hosting
  // return uploadToLocal(file);
  throw new Error('Local upload not yet configured');
}

async function uploadToCloudinary(file: File): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', UPLOAD_PRESET);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    { method: 'POST', body: formData }
  );

  if (!res.ok) throw new Error('Image upload failed');
  const data = await res.json();
  return data.secure_url as string;
}

// VPS implementation — uncomment and configure when self-hosting
// async function uploadToLocal(file: File): Promise<string> {
//   const formData = new FormData();
//   formData.append('file', file);
//   const res = await fetch('/api/upload', { method: 'POST', body: formData });
//   if (!res.ok) throw new Error('Upload failed');
//   const data = await res.json();
//   return data.url as string;
// }
