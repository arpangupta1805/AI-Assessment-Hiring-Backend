/**
 * Email Service
 * Handles sending emails using nodemailer or other providers
 */

import nodemailer from 'nodemailer';

class EmailService {
  constructor() {
    this.transporter = null;
    this.initialized = false;
  }

  /**
   * Initialize the email transporter
   */
  init() {
    if (this.initialized) return;

    // For development, use console logging
    if (process.env.NODE_ENV === 'development' && !process.env.SMTP_HOST) {
      console.log('📧 Email service running in development mode (console only)');
      this.initialized = true;
      return;
    }

    // Production SMTP configuration
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    this.initialized = true;
    console.log('📧 Email service initialized with SMTP');
  }

  /**
   * Send an email
   * @param {string} to - Recipient email
   * @param {string} subject - Email subject
   * @param {string} html - HTML body content
   * @param {object} options - Additional options
   */
  async sendEmail(to, subject, html, options = {}) {
    if (!this.initialized) {
      this.init();
    }

    const mailOptions = {
      from: options.from || process.env.EMAIL_FROM || 'noreply@hiringplatform.com',
      to,
      subject,
      html,
      ...options,
    };

    // Development mode - just log
    if (!this.transporter) {
      console.log('═══════════════════════════════════════════════');
      console.log('📧 EMAIL (DEV MODE)');
      console.log('To:', to);
      console.log('Subject:', subject);
      console.log('Body Preview:', html.substring(0, 200) + '...');
      console.log('═══════════════════════════════════════════════');
      return { messageId: 'dev-' + Date.now() };
    }

    // Production mode - send via SMTP
    try {
      const result = await this.transporter.sendMail(mailOptions);
      console.log('📧 Email sent successfully to:', to);
      return result;
    } catch (error) {
      console.error('❌ Email send failed:', error);
      throw error;
    }
  }

  /**
   * Send OTP email
   */
  async sendOTP(email, otp) {
    const subject = `Your verification code: ${otp}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Verification Code</h2>
        <p>Your verification code is:</p>
        <div style="background: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">
          ${otp}
        </div>
        <p>This code will expire in 10 minutes.</p>
        <p style="color: #666; font-size: 12px;">If you did not request this code, please ignore this email.</p>
      </div>
    `;

    return this.sendEmail(email, subject, html);
  }

  /**
   * Send assessment invite
   */
  async sendAssessmentInvite(email, data) {
    const { candidateName, roleTitle, companyName, assessmentLink, expiryDate } = data;

    const subject = `You're invited to assess for ${roleTitle} at ${companyName}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Assessment Invitation</h2>
        <p>Hello${candidateName ? ` ${candidateName}` : ''},</p>
        <p>You have been invited to take an assessment for the <strong>${roleTitle}</strong> position at <strong>${companyName}</strong>.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${assessmentLink}" style="background: #4CAF50; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
            Start Assessment
          </a>
        </div>
        <p>This assessment is valid until <strong>${expiryDate}</strong>.</p>
        <p style="color: #666; font-size: 12px;">If the button above doesn't work, copy and paste this link into your browser: ${assessmentLink}</p>
        <p>Good luck!</p>
        <p>Best regards,<br>${companyName} Hiring Team</p>
      </div>
    `;

    return this.sendEmail(email, subject, html);
  }

  /**
   * Send submission confirmation
   */
  async sendSubmissionConfirmation(email, data) {
    const { candidateName, roleTitle, companyName } = data;

    const subject = `Assessment Submitted - ${roleTitle} at ${companyName}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Assessment Submitted</h2>
        <p>Hello ${candidateName},</p>
        <p>Thank you for completing your assessment for <strong>${roleTitle}</strong> at <strong>${companyName}</strong>.</p>
        <p>Your submission has been received and is now under review.</p>
        <p>We will notify you once the evaluation is complete.</p>
        <p>Best regards,<br>${companyName} Hiring Team</p>
      </div>
    `;

    return this.sendEmail(email, subject, html);
  }
}

const emailService = new EmailService();
export default emailService;
