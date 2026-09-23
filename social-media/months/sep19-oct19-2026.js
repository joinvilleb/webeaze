const { rows, checks, steps, tags, pills, stats, browser, bars, options, prompt, ico } = require('../lib');

// Sept 19 to Oct 19 2026. Posting roughly every other day.
// Holiday in range: Columbus Day / Indigenous Peoples' Day, Monday October 12 2026
// (second Monday of October, checked against the calendar, not assumed).
// Mix per the README: 3 discussion posts, 2 client showcases, a dark or purple card
// roughly every third slot. Every number here comes from the live site.

module.exports = {
  label: 'September 19 to October 19, 2026',
  posts: [

{ id:'01-autumn-open', cls:'ink', bg:'images/autumn-road.jpg', footRight:'Free preview', inner:()=>`
  <div class="mid"><div class="eyebrow light">THE QUIET STRETCH</div>
  <h1 class="on-ink">The season just<br>turned. So did<br><span class="ac">your busy months.</span></h1>
  <p class="lede light">Roofers and HVAC are about to get slammed. Landscapers are winding down. Either way, the website people find you on should already say the right thing.</p></div>` },

{ id:'02-ask-season', cls:'cream', footRight:'Tell us below', inner:()=>`
  <div class="qmark">?</div>
  <div class="mid"><div class="eyebrow">RUNNING A BUSINESS</div>
  <h1 class="sm">Which way does<br>autumn hit you?</h1>
  ${options([['A','Busiest stretch of the year', ico.spark],['B','Slowing right down', ico.dust],['C','About the same', ico.repeat],['D','Depends on the weather', ico.cal]])}
  ${prompt('One letter in the comments')}</div>` },

{ id:'03-showcase-grassgoats', cls:'ink', footRight:'Dover, DE', inner:(d)=>`
  <div class="mid"><div class="eyebrow light">RECENT WORK</div><h1 class="on-ink sm">Grass Goats Lawn Care</h1>
  ${browser('grassgoatslawncare.com', d+'images/case-studies/grassgoats-after.webp', 520)}</div>` },

{ id:'04-hours-change', cls:'cream', footRight:'Live in 2 working days', inner:()=>`
  <div class="mid"><div class="eyebrow">THE ONE THING PEOPLE MISS</div><h1>Shorter days mean<br>different hours</h1>
  <p class="lede">If your winter hours are not on your website yet, someone is going to drive over and find you closed. Send us a message and it is live in two working days.</p>
  ${pills(['No hourly fee','No contract'])}</div>` },

{ id:'05-what-it-costs', cls:'cream', footRight:'Every month, no surprises', inner:()=>`
  <div class="mid"><div class="eyebrow">WHAT IT ACTUALLY COSTS</div><h1>Two numbers.<br>That is the<br>whole menu.</h1>
  ${rows([['Essential','$199/mo'],['Growth','$299/mo'],['One-time setup','$99'],['Long-term contract','None']])}</div>` },

{ id:'06-vs-agency', cls:'plum', footRight:'Same work, different bill', inner:()=>`
  <div class="mid"><div class="eyebrow light">WHY OWNERS SWITCH</div><h1 class="on-plum">The upfront<br>number is the<br>whole problem.</h1>
  ${bars([['Agency','100','$5k to $25k',false],['Freelancer','45','$1.5k to $8k',false],['WebEaze','12','$99 setup',true]])}</div>` },

{ id:'07-found-on-google', cls:'cream', footRight:'Included on every plan', inner:()=>`
  <div class="mid"><div class="eyebrow">BEFORE THE HOLIDAY SEARCHES START</div><h1>People search<br>early. Be there<br>early.</h1>
  ${checks(['Local SEO on every plan','Google Business Profile managed on Growth','Written so AI search can quote you'])}</div>` },

{ id:'08-ask-found', cls:'cream', footRight:'Tell us below', inner:()=>`
  <div class="qmark">?</div>
  <div class="mid"><div class="eyebrow">HONESTLY THOUGH</div>
  <h1 class="sm">How do most of<br>your customers<br>find you?</h1>
  ${options([['A','Word of mouth', ico.chat],['B','Google', ico.search],['C','Social media', ico.thumb],['D','Drove past the van', ico.phone]])}
  ${prompt('One letter in the comments')}</div>` },

{ id:'09-columbus-day', cls:'ink', footRight:'Back Tuesday', inner:()=>`
  <div class="mid"><div class="eyebrow light">MONDAY OCTOBER 12</div>
  <h1 class="on-ink">We are closed<br>for the holiday.</h1>
  <p class="lede light">Send a request any time and it will be waiting for us Tuesday morning. Your website keeps running either way, as it does every day.</p></div>` },

{ id:'10-what-you-own', cls:'cream', footRight:'Yours, on paper', inner:()=>`
  <div class="mid"><div class="split">
    <div><div class="eyebrow">A FAIR QUESTION</div><h2 class="serif">"What do<br>I actually<br>own?"</h2></div>
    <div>${stats([['Your domain','In your name, always'],['Your content','Words and photos are yours'],['Your site','Leave and take it with you']])}</div>
  </div></div>` },

{ id:'11-showcase-clam', cls:'ink', footRight:'Clifton Heights, PA', inner:(d)=>`
  <div class="mid"><div class="eyebrow light">RECENT WORK</div><h1 class="on-ink sm">The Original Clam Tavern</h1>
  ${browser('clamtavern.com', d+'images/case-studies/clam-after.webp', 520)}</div>` },

{ id:'12-how-it-works', cls:'cream', footRight:'Free preview in 48 hours', inner:()=>`
  <div class="mid"><div class="eyebrow">FROM HERE TO LIVE</div><h1>Four steps.<br>No deposit<br>to start.</h1>
  ${steps([['1','Talk to us','Ten minutes, no pitch'],['2','See your preview','Built in 48 hours, free'],['3','Approve and pay','Only if you like it'],['4','Go live','5 to 14 days']])}</div>` },

{ id:'13-ask-putting-off', cls:'plum', footRight:'Tell us below', inner:()=>`
  <div class="qmark light">?</div>
  <div class="mid"><div class="eyebrow light">BE HONEST</div>
  <h1 class="on-plum sm">What is stopping<br>you fixing your<br>website?</h1>
  ${options([['A','The cost', ico.cal],['B','No time to deal with it', ico.dust],['C','Do not know where to start', ico.search],['D','It is fine, probably', ico.thumb]])}
  ${prompt('One letter in the comments')}</div>` },

// Four rows, no eyebrow. With five rows plus an eyebrow this card overflowed at both
// ends: the eyebrow printed over the wordmark and the last row sat on the footer.
{ id:'14-updates-included', cls:'cream', footRight:'No per-change fees', inner:()=>`
  <div class="mid"><h1>Change it as<br>often as you<br>need to.</h1>
  ${rows([['New photos','Included'],['Price changes','Included'],['Seasonal hours','Included'],['A whole new page','Included']])}</div>` },

{ id:'15-q4-checklist', cls:'cream', footRight:'Free to ask', inner:()=>`
  <div class="mid"><div class="eyebrow">BEFORE THE YEAR ENDS</div><h1>Four things worth<br>checking today</h1>
  ${rows([['Are your hours current?','Check'],['Do your photos look like this year?','Check'],['Does your contact form send?','Check'],['Do you rank for your town?','Check']])}</div>` },

{ id:'16-close', cls:'plum', footRight:'No commitment', inner:()=>`
  <div class="mid"><h1 class="on-plum huge">See it first.<br>Pay after.</h1>
  <p class="lede light">We build a real preview of your new website in 48 hours, free. If you do not like it, that is the end of it and it costs you nothing.</p>
  ${pills(['Free preview','No contract'])}</div>` },

  ],
};
