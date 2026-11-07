# Accounts

One sign-in page (`/signin.html`) serves customers and staff. They have **separate accounts**:

| | Customer | Staff (admin) |
|---|---|---|
| Created by | "Create account" on the sign-in page | Email listed in the `ADMIN_EMAILS` secret |
| Signs in with | Email + password | Email + password (first time: "Staff? Email me a code", then choose a password) |
| Lands on | `/account.html` (My account) | `/admin.html` |
| Session | 30 days | 12 hours |

A customer session can never run admin actions, and removing an email from `ADMIN_EMAILS` ends that person's admin access immediately.

## Buying
- Pressing **Pay** while signed out sends the visitor to `/signin.html?next=...`; after signing in or creating an account they return to the same page with the plan still selected.
- Orders and prepaid codes are linked to the account and listed on **My account**.
- Turn the requirement off in **Admin → Customers → Buying needs an account**. It does not affect the WiFi sign-in pages that run on the router (they call the API from another origin and are exempt).

## Secrets
```
npx wrangler secret put ADMIN_EMAILS     # comma-separated staff emails (already set if admin sign-in worked)
npx wrangler secret put OTP_SALT         # already set
npx wrangler secret put RESEND_API_KEY   # optional: sends "forgot password" codes to customers
npx wrangler secret put MAIL_FROM        # e.g. CessproNet <no-reply@yourdomain.com> (must be a Resend-verified sender)
```
Without `RESEND_API_KEY` + `MAIL_FROM`, customers cannot reset a forgotten password by email (they see a message to contact support). Staff codes still arrive by Telegram, as before.

## Security notes
- Passwords are stored as PBKDF2-SHA256 (100,000 rounds, random salt). Session tokens are random and stored hashed.
- 8 wrong passwords for one email locks sign-in for 15 minutes; sign-ups are limited per connection.
- Email addresses are not verified at sign-up. Receipts and codes go to the email the customer types in the Paystack form.
- Users never see another person's data: every "My account" query is scoped to the session's user id.
