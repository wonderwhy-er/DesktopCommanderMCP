// Simple MIME type detection based on file extension
export function getMimeType(filePath: string): string {
  const extension = filePath.toLowerCase().split('.').pop() || '';
  
  // Image types - only the formats we can display
  const imageTypes: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp'
  };
  
  // Document types - supported for analysis
  const documentTypes: Record<string, string> = {
    'pdf': 'application/pdf'
  };
  
  // Check if the file is an image
  if (extension in imageTypes) {
    return imageTypes[extension];
  }
  
  // Check if the file is a supported document
  if (extension in documentTypes) {
    return documentTypes[extension];
  }
  
  // Default to text/plain for all other files
  return 'text/plain';
}

export function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export function isPdfFile(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}