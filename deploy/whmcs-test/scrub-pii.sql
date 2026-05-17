-- ===========================================================================
-- scrub-pii.sql — applied to a DISPOSABLE staging DB loaded from the raw
-- prod dump, BEFORE any data is loaded into the local WHMCS containers.
--
-- Mandated (user): replace ALL emails + phone numbers with dummies.
-- Best practice (user-approved): neutralize secrets, truncate sensitive
-- logs / card data, reset admin to a known dev login. Real client
-- names/addresses are intentionally KEPT for realistic demo data.
--
-- Idempotent (safe to re-run). __ADMIN_PWHASH__ is substituted by
-- seed-from-prod.sh with a freshly computed bcrypt hash.
-- Run with --force so an optional table/column missing on a given WHMCS
-- minor does not abort the mandated core scrubs (which run first).
-- ===========================================================================

SET SESSION sql_mode = '';
SET FOREIGN_KEY_CHECKS = 0;

-- ---- MANDATED: emails → dev+<id>@example.test, phones → +10000000000 ----
UPDATE tblclients   SET email = CONCAT('dev+', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';
UPDATE tblclients   SET phonenumber = '+10000000000'
                       WHERE phonenumber IS NOT NULL AND phonenumber <> '';
UPDATE tblcontacts  SET email = CONCAT('dev+c', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';
UPDATE tblcontacts  SET phonenumber = '+10000000000'
                       WHERE phonenumber IS NOT NULL AND phonenumber <> '';
UPDATE tblusers     SET email = CONCAT('dev+u', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';
UPDATE tblticketreplies SET email = CONCAT('dev+tr', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';
UPDATE tbltickets   SET email = CONCAT('dev+tk', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';

-- ---- TRUNCATE high-risk PII / secret logs + card data ----
TRUNCATE TABLE tblcreditcards;
TRUNCATE TABLE tblemails;
TRUNCATE TABLE tblgatewaylog;
TRUNCATE TABLE tblactivitylog;
TRUNCATE TABLE tbladminlog;
TRUNCATE TABLE tblapilog;

-- ---- Blank gateway / server / config secrets ----
UPDATE tblpaymentgateways
  SET value = ''
  WHERE setting REGEXP '(?i)(secret|password|apikey|api_key|privatekey|private_key|signature|token|publishable|clientid|client_secret|webhook)';
UPDATE tblconfiguration
  SET value = ''
  WHERE setting REGEXP '(?i)(password|secret|apikey|api_key|privatekey|private_key|token|smtppass)';
UPDATE tblservers
  SET password = '', accesshash = ''
  WHERE 1 = 1;

-- ---- Reset to a single known DEV admin (creds documented in runbook) ----
-- Keep the lowest-id admin, scrub PII + 2FA, set a known bcrypt password.
UPDATE tbladmins
  SET username   = 'admin',
      email      = 'devadmin@example.test',
      password   = '__ADMIN_PWHASH__',
      authmodule = '',
      authdata   = '',
      password_reset_key  = '',
      password_reset_data = NULL,
      password_reset_expiry = NULL,
      loginattempts = 0,
      disabled   = 0
  WHERE id = (SELECT mid FROM (SELECT MIN(id) AS mid FROM tbladmins) z);
DELETE FROM tbladmins
  WHERE id <> (SELECT mid FROM (SELECT MIN(id) AS mid FROM tbladmins) z);

-- ---- Let the External API authenticate from localhost ----
-- tblapi_credentials exists once prod has created API credentials.
UPDATE tblapi_credentials SET ip_restriction = '' WHERE 1 = 1;

-- ---- Disable CAPTCHA for local dev (decompiled captcha.tpl shows the
-- gate is isEnabled()=CaptchaSetting AND isEnabledForForm()=CaptchaForms;
-- blanking only the provider keys falls back to the built-in image
-- captcha, so we kill all three gates).
UPDATE tblconfiguration SET value = 'off' WHERE setting = 'CaptchaSetting';
UPDATE tblconfiguration SET value = '{}'  WHERE setting = 'CaptchaForms';
UPDATE tblconfiguration SET value = ''
  WHERE setting IN ('ReCAPTCHAPublicKey','ReCAPTCHAPrivateKey',
                    'hCaptchaPublicKey','hCaptchaPrivateKey');

SET FOREIGN_KEY_CHECKS = 1;
