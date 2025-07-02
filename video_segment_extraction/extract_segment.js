#!/usr/bin/env node

/**
 * Video Segment Extraction Tool
 * 
 * This script extracts a segment from a video file based on start and end timestamps.
 * 
 * Usage:
 *   node extract_segment.js <video_path> <start_timestamp> <end_timestamp>
 * 
 * Example:
 *   node extract_segment.js video.mp4 00:01:30 00:02:45
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Convert __filename and __dirname to ES modules equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if FFmpeg is installed
function checkFFmpeg() {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-version']);
    
    ffmpeg.on('error', (err) => {
      reject(new Error('FFmpeg is not installed or not in PATH. Please install FFmpeg first.'));
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error('Error checking FFmpeg installation.'));
      }
    });
  });
}

// Validate timestamp format (HH:MM:SS)
function validateTimestamp(timestamp) {
  const pattern = /^(\d{1,2}):(\d{1,2}):(\d{1,2})$/;
  if (!pattern.test(timestamp)) {
    return false;
  }
  
  const [hours, minutes, seconds] = timestamp.split(':').map(Number);
  
  if (minutes >= 60 || seconds >= 60) {
    return false;
  }
  
  return true;
}

// Extract video segment
function extractSegment(videoPath, startTime, endTime) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(videoPath)) {
      reject(new Error(`Video file not found: ${videoPath}`));
      return;
    }
    
    if (!validateTimestamp(startTime) || !validateTimestamp(endTime)) {
      reject(new Error('Invalid timestamp format. Use HH:MM:SS format.'));
      return;
    }
    
    const videoFileName = path.basename(videoPath, path.extname(videoPath));
    const outputFileName = `${videoFileName}_segment_${startTime.replace(/:/g, '-')}_to_${endTime.replace(/:/g, '-')}${path.extname(videoPath)}`;
    const outputPath = path.join(path.dirname(videoPath), outputFileName);
    
    console.log(`Extracting segment from ${startTime} to ${endTime}...`);
    
    const ffmpeg = spawn('ffmpeg', [
      '-i', videoPath,
      '-ss', startTime,
      '-to', endTime,
      '-c', 'copy',  // Use copy mode for faster extraction without re-encoding
      '-y',          // Overwrite output file if it exists
      outputPath
    ]);
    
    ffmpeg.stdout.on('data', (data) => {
      console.log(`${data}`);
    });
    
    ffmpeg.stderr.on('data', (data) => {
      // FFmpeg outputs progress information to stderr
      process.stdout.write('.');
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`\nSegment successfully extracted to: ${outputPath}`);
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to start FFmpeg process: ${err.message}`));
    });
  });
}

// Main function
async function main() {
  try {
    // Check command line arguments
    if (process.argv.length !== 5) {
      console.error('Usage: node extract_segment.js <video_path> <start_timestamp> <end_timestamp>');
      console.error('Example: node extract_segment.js video.mp4 00:01:30 00:02:45');
      process.exit(1);
    }
    
    const videoPath = process.argv[2];
    const startTime = process.argv[3];
    const endTime = process.argv[4];
    
    // Check if FFmpeg is installed
    await checkFFmpeg();
    
    // Extract the segment
    await extractSegment(videoPath, startTime, endTime);
    
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run the main function
main();
