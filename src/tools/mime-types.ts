// Simple MIME type detection based on file extension
export function getMimeType(filePath: string): string {
  const extension = filePath.toLowerCase().split('.').pop() || '';

  if (extension === "pdf") {
    return "application/pdf";
  }

  // Image types - only the formats we can display
  const imageTypes: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp'
  };

  // Check if the file is an image
  if (extension in imageTypes) {
    return imageTypes[extension];
  }

  // Default to text/plain for all other files
  return 'text/plain';
}

export function isPdfFile(mimeType: string): boolean {
  const [baseType] = mimeType.toLowerCase().split(';');
  return baseType.trim() === 'application/pdf';
}

export function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}