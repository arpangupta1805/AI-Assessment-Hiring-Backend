import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import EmailTemplate from '../models/EmailTemplate.js';
import connectDB from '../config/db.js';

// Load env vars
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const seed = async () => {
    try {
        await connectDB();
        console.log('✅ Connected to MongoDB');

        console.log('🌱 Seeding default email templates...');
        await EmailTemplate.seedDefaults();
        console.log('✅ Default templates seeded successfully');

        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    }
};

seed();
