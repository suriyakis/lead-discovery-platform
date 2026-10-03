// Port-aware TLS mode for SMTP and IMAP. Pure: no I/O, no mail libraries,
// so both the nodemailer / imapflow provider (./smtp-imap.ts) and the
// PC-09 credential-free probe (./probe.ts) connect the same way.

/**
 * Port-aware override for the SMTP `secure` flag. nodemailer's `secure:true`
 * means *implicit* TLS-on-connect; on a STARTTLS port (587 / 25) that produces
 * `tls_validate_record_header: wrong version number` because the server replies
 * with a plain text `220` greeting and the TLS layer can't parse it.
 *
 * Operators routinely mis-set this in the UI (set "SSL/TLS on" for a 587
 * mailbox because they think "on means encrypted"). We auto-correct for the
 * well-known ports so the toggle is forgiving; for non-standard ports the
 * operator's choice still wins.
 *
 *   465 / 25 / 587 → SMTP submission ports (RFC 6409)
 *   465: implicit SSL
 *   587: STARTTLS
 *   25:  STARTTLS (no auth, mostly legacy)
 */
export function resolveSmtpSecure(port: number, operatorChoice: boolean): boolean {
  if (port === 465) return true;
  if (port === 587 || port === 25) return false;
  return operatorChoice;
}

/**
 * Port-aware override for the IMAP `secure` flag. imapflow uses the same
 * `secure:true = implicit TLS` semantics as nodemailer; pointing it at port
 * 143 with secure=true causes the same plain-greeting parse failure.
 *
 *   993: implicit SSL
 *   143: STARTTLS
 */
export function resolveImapSecure(port: number, operatorChoice: boolean): boolean {
  if (port === 993) return true;
  if (port === 143) return false;
  return operatorChoice;
}
