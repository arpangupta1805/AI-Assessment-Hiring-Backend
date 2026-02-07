import mongoose from 'mongoose';

/**
 * Company Model
 * Stores company/organization information for recruiters
 */
const CompanySchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        logo: {
            type: String,
            default: '',
        },
        website: {
            type: String,
            default: '',
        },
        description: {
            type: String,
            default: '',
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

// Redundant with unique: true in field definition
// CompanySchema.index({ email: 1 });
CompanySchema.index({ name: 1 });

const Company = mongoose.model('Company', CompanySchema);

export default Company;
