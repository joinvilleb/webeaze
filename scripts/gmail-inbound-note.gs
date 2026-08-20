/**
 * WebEaze — keep the portal notes thread in sync with email, both directions.
 *
 * Setup (once):
 *   1. script.google.com  ->  New project, paste this in.
 *   2. Fill in FUNCTION_URL (your Supabase inbound-note URL) and SECRET (same value you set
 *      as the INBOUND_SECRET function secret).
 *   3. Run ingestClientReplies once — approve the Gmail permission prompt.
 *   4. Triggers (clock icon) -> Add Trigger -> ingestClientReplies -> Time-driven ->
 *      Minutes timer -> Every 5 minutes.  Save.
 *
 * What it does, every 5 minutes:
 *   - Inbound: any new email from an ACTIVE client lands in their portal notes (author 'client'),
 *     INCLUDING any photos they attached, which are uploaded and shown on the note.
 *   - Outbound: any reply YOU send from support@webeaze.io to a client lands in the SAME thread
 *     (author 'team'), so the client sees both sides, not just their own messages.
 * The Supabase function decides who is a client and which side each message belongs to; this just
 * hands it fresh inbox + sent mail. Automated portal emails go out via Resend (not Gmail), so they
 * never appear in Sent and are never double-posted.
 *
 * Photos: a trade client takes pictures on the job, on their phone. "Just email them to us" is the
 * only intake they will actually use, so attachments on an inbound message are sent along as base64
 * and stored against the note.
 */

var FUNCTION_URL = 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/inbound-note';
var SECRET = 'PASTE_THE_SAME_INBOUND_SECRET_HERE';

// Attachment limits. Gmail happily accepts a 25MB attachment, but base64 inflates it by a third and
// the whole thing has to fit in one request, so keep both the per-file and the per-email size sane.
var MAX_FILES_PER_EMAIL = 10;
var MAX_FILE_BYTES = 10 * 1024 * 1024;    // 10MB per file
var MAX_TOTAL_BYTES = 20 * 1024 * 1024;   // 20MB per email, before base64
var ALLOWED = /^(image\/|application\/pdf$)/i;

// Trigger entry point: run both directions. One failing does not stop the other.
function ingestClientReplies() {
  try { ingestInbound_(); } catch (e) { Logger.log('inbound run failed: ' + e); }
  try { ingestOurReplies_(); } catch (e) { Logger.log('sent run failed: ' + e); }
}

/**
 * Photos and documents a client attached, as base64 for the function to store.
 *
 * includeInlineImages:false is the load-bearing option here. Almost every business email carries a
 * logo, headshot or social icon INLINE in the signature. Without this, every single reply would post
 * two or three junk "photos" into their notes thread and the feature would be worse than useless.
 */
function readAttachments_(msg) {
  var out = [];
  var total = 0;
  var atts;
  try {
    atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
  } catch (e) {
    Logger.log('could not read attachments: ' + e);
    return out;
  }
  for (var i = 0; i < atts.length && out.length < MAX_FILES_PER_EMAIL; i++) {
    try {
      var a = atts[i];
      var type = String(a.getContentType() || '');
      if (!ALLOWED.test(type)) continue;                 // skip calendar invites, zips, exe, etc.
      var size = a.getSize();
      if (!size || size > MAX_FILE_BYTES) continue;
      if (total + size > MAX_TOTAL_BYTES) break;          // stop before the request gets too big
      total += size;
      out.push({
        filename: a.getName(),
        mimeType: type,
        data: Utilities.base64Encode(a.getBytes())
      });
    } catch (eAtt) {
      Logger.log('skip attachment: ' + eAtt);             // one unreadable file must not lose the email
    }
  }
  return out;
}

// ── Inbound: clients' email replies -> their portal notes (author 'client') ──
function ingestInbound_() {
  var props = PropertiesService.getScriptProperties();
  // Only look at messages that arrived since the last run (first run: last 2 days).
  var lastRun = Number(props.getProperty('lastRun') || (Date.now() - 2 * 24 * 3600 * 1000));
  var maxSeen = lastRun;

  // Recent inbox mail that isn't from us. 'newer_than:3d' bounds the search cheaply.
  // Gmail search can throw a transient "Gmail operation not allowed" now and then, so retry once.
  var threads = searchWithRetry_('in:inbox newer_than:3d -from:webeaze.io', 60);
  if (threads === null) return;   // Gmail unavailable this run; next run (5 min) picks it up. Do not throw.

  for (var i = 0; i < threads.length; i++) {
    // Isolate each thread: one odd/inaccessible thread (deleted mid-run, a Chat thread, etc.) throws
    // "Gmail operation not allowed" and must not kill the whole run and email a failure notice.
    var msgs;
    try { msgs = threads[i].getMessages(); }
    catch (eThread) { Logger.log('skip thread ' + i + ': ' + eThread); continue; }

    for (var j = 0; j < msgs.length; j++) {
      try {
        var msg = msgs[j];
        var ts = msg.getDate().getTime();
        if (ts <= lastRun) continue;                       // already handled in a previous run
        var from = msg.getFrom();
        if (/@webeaze\.io/i.test(from)) { if (ts > maxSeen) maxSeen = ts; continue; } // our own send

        var payload = {
          from: from,
          subject: msg.getSubject(),
          text: msg.getPlainBody(),
          messageId: msg.getId(),
          receivedAt: msg.getDate().toISOString(),
          attachments: readAttachments_(msg)   // photos from the job, straight into their notes
        };
        var resp = UrlFetchApp.fetch(FUNCTION_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-inbound-secret': SECRET },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        // Only mark this message as handled if the function actually accepted it; otherwise leave
        // maxSeen where it was so it retries next run. The function dedupes on messageId, so a
        // replay after a lost response posts nothing twice (needs supabase/inbound_dedupe.sql).
        if (resp.getResponseCode() < 300 && ts > maxSeen) maxSeen = ts;
      } catch (eMsg) {
        Logger.log('skip message: ' + eMsg);   // transient read/network error: retried next run
        continue;
      }
    }
  }
  props.setProperty('lastRun', String(maxSeen));
}

// ── Outbound: our replies (support@webeaze.io) -> the SAME client's notes (author 'team') ──
function ingestOurReplies_() {
  var props = PropertiesService.getScriptProperties();
  var lastSent = Number(props.getProperty('lastSent') || (Date.now() - 2 * 24 * 3600 * 1000));
  var maxSent = lastSent;

  // Our recently sent mail. The function matches the recipient to a client and ignores the rest,
  // so ordinary emails to non-clients are simply skipped.
  var threads = searchWithRetry_('in:sent newer_than:3d from:support@webeaze.io', 60);
  if (threads === null) return;

  for (var i = 0; i < threads.length; i++) {
    var msgs;
    try { msgs = threads[i].getMessages(); }
    catch (eThread) { Logger.log('skip sent thread ' + i + ': ' + eThread); continue; }

    for (var j = 0; j < msgs.length; j++) {
      try {
        var msg = msgs[j];
        // Only OUR support sends. Do NOT touch maxSent for other messages in the thread (client
        // replies live here too): advancing it on those could skip a later, older reply of ours.
        if (!/support@webeaze\.io/i.test(msg.getFrom())) continue;
        var ts = msg.getDate().getTime();
        if (ts <= lastSent) continue;                      // already handled in a previous run

        var payload = {
          team: true,
          to: msg.getTo(),
          from: msg.getFrom(),
          subject: msg.getSubject(),
          text: msg.getPlainBody(),
          messageId: msg.getId(),
          receivedAt: msg.getDate().toISOString()
          // No attachments on our side: what we send is already in the portal.
        };
        var resp = UrlFetchApp.fetch(FUNCTION_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-inbound-secret': SECRET },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        // Advance only on acceptance (a non-client recipient returns 200 'skipped', which is fine
        // to advance past; a real error leaves it for the next run to retry).
        if (resp.getResponseCode() < 300 && ts > maxSent) maxSent = ts;
      } catch (eMsg) {
        Logger.log('skip sent message: ' + eMsg);
        continue;
      }
    }
  }
  props.setProperty('lastSent', String(maxSent));
}

// Runs a Gmail search, retrying once after a short pause on a transient failure. Returns the thread
// array, or null if Gmail is unavailable this run (caller should just skip, not throw).
function searchWithRetry_(query, limit) {
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      return GmailApp.search(query, 0, limit);
    } catch (e) {
      Logger.log('search attempt ' + (attempt + 1) + ' failed: ' + e);
      if (attempt === 0) Utilities.sleep(1500);
    }
  }
  return null;
}
