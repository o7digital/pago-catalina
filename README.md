# Pago Catalina

Spanish-language storefront, private admin with separate owner and invited-user accounts, persistent package catalog and Stripe Checkout. Static frontend can stay on Vercel. Node backend and SQLite database run on a VPS; Railway is not used.

## Local development

Node 22.13+ (Node 24 recommended).

```sh
npm ci
ADMIN_SETUP_TOKEN=local-activation-token npm run dev
```

Visit `http://localhost:3000/admin#setup=local-activation-token` once to create the owner's email/password (12+ characters). The token is consumed by account creation; it never resets an existing account. The catalog starts empty. Create packages in **Paquetes**. Inactive packages are hidden from the public API. Payment buttons stay disabled until both Stripe secrets exist.

```sh
npm test
npm run build
npx playwright test
```

`npm test` covers authorization, CSRF, credential rotation, catalog validation, server-side pricing, signed/deduplicated webhooks and refunds. Browser tests exercise activation, publication visible from another browser, login/logout and mobile layout. Install Chromium using `npx playwright install chromium` if needed.

## VPS deployment

1. Confirm the target VPS and choose an HTTPS backend address. The existing frontend URL is `https://pago-catalina.vercel.app`.
2. Install Node 24. Copy `server/`, `public/`, `package.json`, and `package-lock.json` to `/opt/pago-catalina`. Run `npm ci --omit=dev` there.
3. Create a system user `catalina` without a login shell. Install `deploy/pago-catalina.service` in `/etc/systemd/system/`.
4. Copy `.env.example` to `/etc/pago-catalina.env`, owned by root, mode `600`. Set a random `ADMIN_SETUP_TOKEN`. Keep the database in `/var/lib/pago-catalina/`, outside releases and Git. Leave Stripe keys blank until configuration is ready.
5. `systemctl daemon-reload && systemctl enable --now pago-catalina`. Check `curl http://127.0.0.1:8120/api/health`.
6. Put the service behind HTTPS using the server's existing reverse proxy. See `deploy/nginx.conf.example`. Bind the app to loopback or a private container network; never expose SQLite or configuration files.
7. Run `npm run configure:backend -- https://YOUR_BACKEND` to set the Vercel API rewrite (an existing path prefix may be included). Deploy using `vercel --prod`, then verify `/api/health`, `/api/packages`, `/admin`, and the homepage. `PUBLIC_ORIGIN` must match the public frontend origin exactly. Preview domains intentionally cannot perform mutations.
8. Open `https://pago-catalina.vercel.app/admin#setup=TOKEN` privately to create Catalina's account. Remove `ADMIN_SETUP_TOKEN` from the environment file and restart after activation. Do not commit or share this link publicly.
9. Install `deploy/backup.sh` to `/usr/local/sbin/pago-catalina-backup`, mode `700`. Schedule daily as root. Backups retain 14 days; copy them off the VPS as well. Restore only while the service is stopped, and restore ownership to `catalina`.

**Deployment gate:** do not publish the new frontend until the backend HTTPS address is reachable and the API rewrite is configured; the existing Vercel demo has no backend.

Never run the SQLite backend as a Vercel function: its storage must persist on the VPS. Existing sessions survive backend restarts and expire after 12 hours. Changing the password revokes only that user’s other sessions. Login and checkout endpoints are rate limited. All admin writes require both same-origin requests and a session CSRF token. The admin API is private; its static login shell is public.

## Stripe: owner steps

Use **Catalina's Stripe account**, so payments go directly to her account. No Stripe Connect platform is required: both administrators manage the same Catalina business and Stripe account.

1. Complete account/business verification and add Catalina's payout bank account in Stripe.
2. Start in a sandbox/test environment. Copy the secret API key (`sk_test_…`) into `STRIPE_SECRET_KEY` in `/etc/pago-catalina.env`. Never paste secrets into chat, browser code, Git, or the admin screen.
3. In Stripe **Workbench → Webhooks → Create an event destination**, select **Your account**, **Snapshot** payloads and these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
4. Destination URL: `https://pago-catalina.vercel.app/api/stripe/webhook`. Copy the destination signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` in the same environment file, then `sudo systemctl restart pago-catalina`.
5. Create a package in Catalina's admin. Test a successful card checkout (`4242 4242 4242 4242`, future expiry, any CVC), a cancellation, and a refund. Check successful webhook deliveries in Stripe and the order states in the admin.
6. For real payments, replace the key with the live account key (`sk_live_…`) and create a **separate live webhook** for the same URL/events. Replace `STRIPE_WEBHOOK_SECRET` with that live destination's signing secret and restart. Never mix test and live secrets.

Stripe-hosted Checkout is created on the server and redirects to the session URL; this flow does not need a publishable `pk_…` key. Packages do not have to be created manually in Stripe: checkout uses the saved package name and price. Payments are currently one-time card payments in MXN. Subscriptions, email receipts configuration, other payment methods are outside this implementation.

The return URL is informational and never marks an order paid. Webhooks verify signatures and retrieve the current Stripe session before updating payment state. Orders retain package names/prices even after editing or deleting a package. Admin lists and totals cover the latest 1,000 orders. Refunds are initiated in Stripe and reflected in the panel, including partial refunds.

Docs: https://docs.stripe.com/checkout/quickstart and https://docs.stripe.com/webhooks

## Current production deployment

- Frontend/admin: `https://pago-catalina.vercel.app` and `/admin`.
- Backend: confirmed VPS `o7-vps` (`51.178.36.17`), isolated systemd service `pago-catalina`, user `catalina`.
- App: `/opt/pago-catalina`; private environment: `/etc/pago-catalina.env` (root-only); persistent state: `/var/lib/pago-catalina`.
- Private listener: `172.22.1.1:8120`, reachable only from the current HTTPS proxy `172.22.1.16` through an explicit UFW rule. `TRUSTED_PROXY` is set to that exact proxy address. If the Mailcow proxy is recreated with a different private address, update this rule and trusted-proxy setting together.
- Backend HTTPS prefix: `https://mail.o7digitalgroup.com/catalina-backend`. Only `/catalina-backend/api/` is proxied. No Mailcow, CRM, database or existing proxy route was replaced.
- Added proxy include: `/opt/o7/mailcow/data/conf/nginx/site.catalina-backend.custom`, tracked template `deploy/nginx-mailcow-catalina.custom`. The proxy configuration was validated with `nginx -t`, then gracefully reloaded; its container and the CRM container were not restarted.
- Limits: 256 MiB memory, 30% of one CPU, 64 tasks; process runs with a lower scheduling priority.
- Local SQLite backups: `/var/backups/pago-catalina`, owner root, retention 14 days. Job: `/etc/cron.d/pago-catalina-backup`, daily at 05:17 UTC. Initial backup completed successfully. Off-server replication is not configured.
- Stripe secrets are deliberately blank. No live Stripe transaction has been performed. The original owner account has been activated; its credentials and sessions are preserved when upgrading to multi-user access.

To update only Catalina, copy the changed application files to `/opt/pago-catalina`, run `npm ci --omit=dev` if dependencies changed and `sudo systemctl restart pago-catalina`. Do not run any Mailcow/CRM Compose commands. Keep `/etc/pago-catalina.env` and `/var/lib/pago-catalina` intact.

To remove the Catalina integration, first revert the frontend to the prior Vercel deployment. Stop/disable only `pago-catalina`, remove only `site.catalina-backend.custom`, run `nginx -t` and gracefully reload the existing Nginx container. Delete only the UFW rule identified by comment `Catalina private HTTPS proxy`. Keep the database/backups until their owner requests deletion.


## Separate accounts and email verification

The existing owner account is migrated automatically, keeping its email, password hash and active sessions. A transactional migration moves the original `admin` row into `users` and associates legacy sessions with that owner. Back up before upgrading; an old-code rollback also requires the pre-migration database backup.

In **Cuenta y accesos**, the owner enters Catalina’s email and creates a private invitation. Share the generated link only with her. Links are email-bound, expire after 48 hours and can be revoked. Creating a replacement invitation invalidates previous invitations for that email. This action creates a link; it does not automatically send an invitation email.

Catalina opens the link, chooses her own password and enters the six-digit code sent to the invited address. Only then is her account created. Email verification is enabled automatically, and every subsequent login requires her password followed by a new emailed code. She can manage the shared packages and orders, while only the owner can invite other users. Changing one person’s password never changes or signs out the other person.

The existing owner can opt into the same protection under **Cuenta y accesos → Activar verificación por correo**, confirming the current password and an emailed code. Enabling it signs out that user’s previous sessions. The UI provides no password-only bypass or self-service MFA disable. If mailbox access is lost, the server operator must verify ownership before any manual recovery.

Codes expire after 10 minutes, are accepted once, allow at most five incorrect attempts and are never logged or returned by APIs. The database stores hashes salted by a random challenge token kept only by the client. Resends require a 60-second wait and are limited to three deliveries per challenge; they do not reset the attempt limit or expiry. SMTP failure never creates an account, enables MFA or grants a login session.

Configure SMTP using `.env.example`. `SMTP_HOST`, `MAIL_FROM` and validated STARTTLS/implicit TLS are required. Credentials are optional only for an already trusted private relay. Production uses the existing Mailcow private relay `172.22.1.253:25`, TLS name `mail.o7digitalgroup.com`, and sender `acceso@o7digitalgroup.com`. No Mailcow account, Docker service or mail configuration was changed. `SMTP_USER` and `SMTP_PASSWORD` are unnecessary on this existing trusted private network. SMTP connectivity and the TLS certificate were verified before deployment; actual mailbox delivery can be checked when a user requests a code.

For local browser testing, `test/browser-server.mjs` injects a fake mailer whose messages are stored only in `/tmp/catalina-browser-mail.json`. Production starts exclusively via `server/start.mjs` and has no code-reading endpoint. Tests cover migration compatibility, separate accounts, invitation expiry/revocation, MFA enrollment/login, attempt/expiry/replay protection and SMTP failures.
