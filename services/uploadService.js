/**
 * File Upload Service
 * Handles local file storage for resumes and images
 */

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base upload directory
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const RESUME_DIR = path.join(UPLOAD_DIR, 'resumes');
const IMAGE_DIR = path.join(UPLOAD_DIR, 'images');

// Ensure directories exist
[UPLOAD_DIR, RESUME_DIR, IMAGE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
    }
});

// File filter for resumes
const resumeFileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
    ];

    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF, DOC, DOCX, and TXT are allowed.'), false);
    }
};

// File filter for images
const imageFileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'), false);
    }
};

// Generate unique filename
const generateFilename = (prefix, originalname) => {
    const ext = path.extname(originalname);
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${timestamp}_${random}${ext}`;
};

// Resume storage configuration
const resumeStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, RESUME_DIR);
    },
    filename: (req, file, cb) => {
        const filename = generateFilename('resume', file.originalname);
        cb(null, filename);
    },
});

// Image storage configuration
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, IMAGE_DIR);
    },
    filename: (req, file, cb) => {
        const filename = generateFilename('photo', file.originalname);
        cb(null, filename);
    },
});

// Multer upload instances
export const uploadResume = multer({
    storage: resumeStorage,
    fileFilter: resumeFileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB max
    },
});

export const uploadImage = multer({
    storage: imageStorage,
    fileFilter: imageFileFilter,
    limits: {
        fileSize: 2 * 1024 * 1024, // 2MB max
    },
});

// Save base64 image to file
export const saveBase64Image = async (base64Data, prefix = 'photo') => {
    try {
        // Remove data URL prefix if present
        let imageData = base64Data;
        let ext = '.png';

        if (base64Data.startsWith('data:image/')) {
            const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
            if (matches) {
                ext = '.' + matches[1].replace('jpeg', 'jpg');
                imageData = matches[2];
            }
        }

        const filename = generateFilename(prefix, `image${ext}`);
        const filepath = path.join(IMAGE_DIR, filename);

        // Write file
        const buffer = Buffer.from(imageData, 'base64');
        await fs.promises.writeFile(filepath, buffer);

        // Return relative URL path
        return `/uploads/images/${filename}`;
    } catch (error) {
        console.error('❌ Error saving base64 image:', error);
        throw error;
    }
};

// Get file URL from filename
export const getFileUrl = (type, filename) => {
    if (!filename) return '';
    if (filename.startsWith('/uploads/') || filename.startsWith('http')) {
        return filename; // Already a URL
    }
    return `/uploads/${type}/${filename}`;
};

// Delete file
export const deleteFile = async (filepath) => {
    try {
        // Handle relative paths
        let fullPath = filepath;
        if (filepath.startsWith('/uploads/')) {
            fullPath = path.join(__dirname, '..', filepath);
        }

        if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
            console.log(`🗑️ Deleted file: ${fullPath}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ Error deleting file:', error);
        return false;
    }
};

// Extract text from resume (basic implementation)
export const extractResumeText = async (filepath) => {
    try {
        const ext = path.extname(filepath).toLowerCase();

        // For now, only handle .txt files directly
        // For PDF/DOC, you'd need additional libraries like pdf-parse or mammoth
        if (ext === '.txt') {
            const fullPath = filepath.startsWith('/uploads/') ? path.join(__dirname, '..', filepath) : filepath;
            if (fs.existsSync(fullPath)) {
                return await fs.promises.readFile(fullPath, 'utf-8');
            }
        } else if (ext === '.pdf') {
            try {
                const fullPath = filepath.startsWith('/uploads/') ? path.join(__dirname, '..', filepath) : filepath;
                if (fs.existsSync(fullPath)) {
                    const dataBuffer = await fs.promises.readFile(fullPath);
                    // Standard pdf-parse v1.1.1 usage
                    const pdfData = await pdf(dataBuffer);
                    return pdfData.text;
                }
            } catch (pdfError) {
                console.error('❌ PDF parsing error:', pdfError);
            }
        }

        console.log(`⚠️ Cannot extract text from ${ext} file. Text should be provided by frontend.`);
        return '';
    } catch (error) {
        console.error('❌ Error extracting resume text:', error);
        return '';
    }
};

export default {
    uploadResume,
    uploadImage,
    saveBase64Image,
    getFileUrl,
    deleteFile,
    extractResumeText,
    UPLOAD_DIR,
    RESUME_DIR,
    IMAGE_DIR,
};
