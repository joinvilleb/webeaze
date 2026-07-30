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
  var threads = GmailApp.search('in:inbox newer_than:3d -from:webeaze.io', 0, 60);

  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
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
      try {
        UrlFetchApp.fetch(FUNCTION_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-inbound-secret': SECRET },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
      } catch (e) {
        // Leave lastRun where it was for this message so it retries next run.
        continue;
      }
      if (ts > maxSeen) maxSeen = ts;
    }
  }
  props.setProperty('lastRun', String(maxSeen));
}
