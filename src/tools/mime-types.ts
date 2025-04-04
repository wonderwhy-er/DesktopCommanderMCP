// Simple MIME type detection based on file extension
export function getMimeType(filePath: string): string {
  const extension = filePath.toLowerCase().split('.').pop() || '';
  
  // Image types
  const imageTypes: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'tif': 'image/tiff',
    'tiff': 'image/tiff',
  };
  
  // Text types - consider everything else as text for simplicity
  
  // Check if the file is an image
  if (extension in imageTypes) {
    return imageTypes[extension];
  }
  
  // Default to text/plain for all other files
  return 'text/plain';
}

export function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}
