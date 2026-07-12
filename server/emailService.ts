import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error('[EMAIL] RESEND_API_KEY is not set — emails will fail');
} else {
  console.log('[EMAIL] Resend initialised with key:', apiKey.slice(0, 8) + '...');
}
const resend = new Resend(apiKey);

const APP_NAME = 'Vib3Pulse';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

interface SendPasswordResetEmailParams {
  to: string;
  resetLink: string;
  userName?: string;
}

export async function sendPasswordResetEmail({ to, resetLink, userName }: SendPasswordResetEmailParams): Promise<boolean> {
  try {
    const { data, error } = await resend.emails.send({
      from: `${APP_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `Reset Your ${APP_NAME} Password`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset Your Password</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">${APP_NAME}</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Reset Your Password</h2>
            <p>Hi${userName ? ` ${userName}` : ''},</p>
            <p>We received a request to reset your password. Click the button below to create a new password:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 40px; border-radius: 8px; font-weight: bold; font-size: 16px;">Reset Password</a>
            </div>
            <p style="color: #666; font-size: 14px;">This link will expire in 1 hour for security reasons.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              This email was sent by ${APP_NAME}. If you have any questions, please contact our support team.
            </p>
          </div>
        </body>
        </html>
      `,
      text: `
Reset Your ${APP_NAME} Password

Hi${userName ? ` ${userName}` : ''},

We received a request to reset your password. Click the link below to create a new password:

${resetLink}

This link will expire in 1 hour for security reasons.

If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.

---
This email was sent by ${APP_NAME}.
      `.trim(),
    });

    if (error) {
      console.error('[EMAIL] Resend error:', JSON.stringify(error, null, 2));
      return false;
    }

    console.log('[EMAIL] Password reset email sent. ID:', data?.id, '| To:', to, '| From:', `${APP_NAME} <${FROM_EMAIL}>`);
    return true;
  } catch (error) {
    console.error('Exception sending password reset email:', error);
    return false;
  }
}

interface SendVerificationEmailParams {
  to: string;
  verifyLink: string;
  userName?: string;
}

export async function sendVerificationEmail({ to, verifyLink, userName }: SendVerificationEmailParams): Promise<boolean> {
  try {
    const { data, error } = await resend.emails.send({
      from: `${APP_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `Verify your ${APP_NAME} email address`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verify Your Email</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">${APP_NAME}</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Verify your email address</h2>
            <p>Hi${userName ? ` ${userName}` : ''},</p>
            <p>Thanks for signing up! Please verify your email address to unlock all features.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verifyLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 40px; border-radius: 8px; font-weight: bold; font-size: 16px;">Verify Email</a>
            </div>
            <p style="color: #666; font-size: 14px;">This link will expire in 24 hours.</p>
            <p style="color: #666; font-size: 14px;">If you didn't create a ${APP_NAME} account, you can safely ignore this email.</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">
              This email was sent by ${APP_NAME}. If you have any questions, please contact our support team.
            </p>
          </div>
        </body>
        </html>
      `,
      text: `
Verify your ${APP_NAME} email address

Hi${userName ? ` ${userName}` : ''},

Thanks for signing up! Please verify your email address by visiting the link below:

${verifyLink}

This link will expire in 24 hours.

If you didn't create a ${APP_NAME} account, you can safely ignore this email.

---
This email was sent by ${APP_NAME}.
      `.trim(),
    });

    if (error) {
      console.error('[EMAIL] Resend error (verification):', JSON.stringify(error, null, 2));
      return false;
    }

    console.log('[EMAIL] Verification email sent. ID:', data?.id, '| To:', to);
    return true;
  } catch (error) {
    console.error('Exception sending verification email:', error);
    return false;
  }
}
