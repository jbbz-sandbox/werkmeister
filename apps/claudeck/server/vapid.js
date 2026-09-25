import { appendFileSync } from "fs";
import { join } from "path";
import { userDir } from "./paths.js";
import { countPushSubscriptions } from "../db.js";

/**
 * Resolve the VAPID key pair, generating and persisting one if absent.
 *
 * Losing these keys is silent and total: every existing browser subscription is
 * bound to the old public key and simply stops receiving pushes, with no error
 * on either side. Hence the noise.
 */
export function resolveVapidKeys(webpush, log = console) {
  const existing = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
  if (existing.publicKey && existing.privateKey) return existing;

  const generated = webpush.generateVAPIDKeys();
  const envPath = join(userDir, ".env");

  let orphaned = 0;
  try {
    orphaned = countPushSubscriptions();
  } catch {
    // Database not ready yet — the count is advisory only.
  }
  if (orphaned > 0) {
    log.warn(
      `WARNING: generating new VAPID keys — ${orphaned} existing push subscription(s) ` +
        `are now orphaned and will never receive another notification. ` +
        `Re-subscribe from each device.`,
    );
  }

  try {
    appendFileSync(
      envPath,
      `\nVAPID_PUBLIC_KEY="${generated.publicKey}"\nVAPID_PRIVATE_KEY="${generated.privateKey}"\n`,
    );
    log.warn(
      `Generated VAPID keys and saved them to ${envPath}. ` +
        `Back this file up: losing it silently breaks push for every subscribed device.`,
    );
  } catch (e) {
    log.error(
      `ERROR: generated VAPID keys but could not write ${envPath}: ${e.message}. ` +
        `Push works for this run only — new keys will be generated on next start ` +
        `and all subscriptions will break. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY manually.`,
    );
  }

  return generated;
}
