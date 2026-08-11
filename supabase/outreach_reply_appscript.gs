/**
 * WebEaze — auto-stop outreach follow-ups when a prospect replies.
 *
 * Runs on the getwebeaze.com OUTREACH mailbox (the one that sends the cold emails), NOT the
 * webeaze.io account. It scans the inbox for fresh replies and hands their sender addresses to the
 * outreach-reply function, which flips those prospects to 'replied' so outreach-send stops chasing
 * anyone who already answered.
 *
 * Setup (once), signed in as hello@getwebeaze.com (your outreach mailbox):
 *   1. script.google.com -> New project, paste this in.
 *   2. Fill FUNCTION_URL (your Supabase outreach-reply URL) and SECRET (your CRON_SECRET value).
 *   3. Run detectOutreachReplies once and approve the Gmail permission prompt.
 *   4. Triggers (clock icon) -> Add Trigger -> detectOutreachReplies -> Time-driven ->
 *      Minutes timer -> Every 15 minutes. Save.
 */

var FUNCTION_URL = 'https://<PROJECT_REF>.supabase.co/functions/v1/outreach-reply';
var SECRET = 'PASTE_YOUR_CRON_SECRET_HERE';

function detectOutreachReplies() {
  var props = PropertiesService.getScriptProperties();
  // Only messages since the last run (first run: last 2 days).
  var lastRun = Number(props.getProperty('lastRun') || (Date.now() - 2 * 24 * 3600 * 1000));
  var maxSeen = lastRun;

  // Recent inbox mail that isn't our own outreach send.
  var threads = searchWithRetry_('in:inbox newer_than:2d -from:getwebeaze.com', 100);
  if (threads === null) return;   // Gmail hiccup; next run picks it up. Do not throw.

  var replies = {};   // real reply senders -> 'replied'
  var bounces = {};   // failed recipient addresses pulled from bounce notices -> 'bounced'
  for (var i = 0; i < threads.length; i++) {
    var msgs;
    try { msgs = threads[i].getMessages(); }
    catch (eThread) { Logger.log('skip thread ' + i + ': ' + eThread); continue; }

    for (var j = 0; j < msgs.length; j++) {
      try {
        var msg = msgs[j];
        var ts = msg.getDate().getTime();
        if (ts <= lastRun) continue;                              // handled in a previous run
        if (ts > maxSeen) maxSeen = ts;
        var from = msg.getFrom();
        if (/@getwebeaze\.com/i.test(from)) continue;             // our own send in the thread

        var isBounce = /mailer-daemon|mail delivery|delivery status|postmaster/i.test(from) ||
                       /delivery status notification|undelivered mail|address not found|failure notice/i.test(msg.getSubject());
        if (isBounce) {
          // A bounce notice: the dead recipient is in the body. Grab any email that isn't ours or a
          // mail-system address.
          var addrs = msg.getPlainBody().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
          for (var k = 0; k < addrs.length; k++) {
            var a = addrs[k].toLowerCase();
            if (!/getwebeaze\.com|webeaze\.io|mailer-daemon|google|googlemail|gmail|postmaster/i.test(a)) bounces[a] = true;
          }
        } else {
          replies[from] = true;                                   // a real reply
        }
      } catch (eMsg) { Logger.log('skip message: ' + eMsg); continue; }
    }
  }

  var payload = { emails: Object.keys(replies), bounced: Object.keys(bounces) };
  if (payload.emails.length || payload.bounced.length) {
    var resp = UrlFetchApp.fetch(FUNCTION_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-cron-secret': SECRET },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    // If the function didn't accept it, leave lastRun where it was so we retry next run
    // (marking a prospect 'replied'/'bounced' is idempotent, so retries are harmless).
    if (resp.getResponseCode() >= 300) { Logger.log('outreach-reply ' + resp.getResponseCode() + ': ' + resp.getContentText()); return; }
  }
  props.setProperty('lastRun', String(maxSeen));
}

// Gmail search with one retry on a transient failure. Returns threads, or null if Gmail is
// unavailable this run (caller should skip, not throw).
function searchWithRetry_(query, limit) {
  for (var attempt = 0; attempt < 2; attempt++) {
    try { return GmailApp.search(query, 0, limit); }
    catch (e) { Logger.log('search attempt ' + (attempt + 1) + ' failed: ' + e); if (attempt === 0) Utilities.sleep(1500); }
  }
  return null;
}
