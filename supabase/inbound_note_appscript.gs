/**
 * WebEaze — forward client email replies into their portal notes.
 *
 * Setup (once):
 *   1. script.google.com  ->  New project, paste this in.
 *   2. Fill in FUNCTION_URL (your Supabase inbound-note URL) and SECRET (same value you set
 *      as the INBOUND_SECRET function secret).
 *   3. Run ingestClientReplies once — approve the Gmail permission prompt.
 *   4. Triggers (clock icon) -> Add Trigger -> ingestClientReplies -> Time-driven ->
 *      Minutes timer -> Every 5 minutes.  Save.
 *
 * After that, any new email from an ACTIVE client lands in their portal notes automatically.
 * The Supabase function decides who is a client; this just hands it every fresh inbox message
 * that is not from us.
 */

var FUNCTION_URL = 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/inbound-note';
var SECRET = 'PASTE_THE_SAME_INBOUND_SECRET_HERE';

function ingestClientReplies() {
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
          receivedAt: msg.getDate().toISOString()
        };
        var resp = UrlFetchApp.fetch(FUNCTION_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-inbound-secret': SECRET },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        // Only mark this message as handled if the function actually accepted it; otherwise leave
        // maxSeen where it was so it retries next run (the function dedups by messageId).
        if (resp.getResponseCode() < 300 && ts > maxSeen) maxSeen = ts;
      } catch (eMsg) {
        Logger.log('skip message: ' + eMsg);   // transient read/network error: retried next run
        continue;
      }
    }
  }
  props.setProperty('lastRun', String(maxSeen));
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
