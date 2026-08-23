const { rows, checks, steps, tags, pills, stats, browser, bars, options, prompt, ico } = require('../lib');

module.exports = {
  label: 'September to October 2026',
  posts: [

{ id:'01-q4-check', cls:'cream', footRight:'Free to ask', inner:()=>`
  <div class="mid"><div class="eyebrow">BEFORE Q4</div><h1>Four things worth<br>checking today</h1>
  ${rows([['Are your hours right?','Check'],['Are your photos from this year?','Check'],['Does your contact form work?','Check'],['Do you rank for your town?','Check']])}</div>` },

{ id:'02-summer-over', cls:'cream', footRight:'Done for you', inner:()=>`
  <div class="mid"><h1 class="huge">Summer is over.<br>Your website<br>should not still<br><span class="ac">say so.</span></h1>
  <p class="lede">Seasonal hours, autumn services, new photos. Send us a message and it is live in two working days.</p></div>` },

{ id:'03-showcase-bear', cls:'ink', footRight:'Harrisburg, PA', inner:(d)=>`
  <div class="mid"><div class="eyebrow light">RECENT WORK</div><h1 class="on-ink sm">Bear Carpet Care</h1>
  ${browser('bearcarpetcare.com', d+'images/case-studies/bear-after.webp', 520)}</div>` },

{ id:'04-holiday-hours', cls:'plum', footRight:'Just send a message', inner:()=>`
  <div class="mid"><div class="eyebrow light">COMING UP</div><h1 class="on-plum">Holiday hours<br>change. Your site<br>should too.</h1>
  ${rows([['Thanksgiving','Nov 26'],['Christmas Eve','Dec 24'],['Christmas Day','Dec 25'],['New Year&#39;s Day','Jan 1']])}</div>` },

{ id:'05-slow-season', cls:'cream', inner:()=>`
  <div class="mid"><div class="eyebrow">GOOD TIMING</div><h1>The slow season is<br>the right season</h1>
  <p class="lede">Rebuilding your website in the middle of your busiest month is miserable. Doing it now, while things are quieter, means you go into next season already found.</p>
  ${pills(['Live in 5 to 14 days','Free preview first'])}</div>` },

{ id:'06-reviews', cls:'cream', footRight:'Growth plan', inner:()=>`
  <div class="mid"><div class="eyebrow">ASK NOW, NOT IN DECEMBER</div><h1>Reviews are<br>seasonal too</h1>
  <p class="lede">The customers you served this summer still remember it. In three months they will not. On the Growth plan we handle the asking for you.</p>
  ${checks(['Review requests sent for you','Google Business Profile managed','New reviews shown on your site'])}</div>` },

{ id:'07-ask-time', cls:'cream', footRight:'Tell us below', inner:()=>`
  <div class="qmark">?</div>
  <div class="mid"><div class="eyebrow">RUNNING A BUSINESS</div>
  <h1 class="sm">What eats the most<br>time in your week?</h1>
  ${options([['A','Quoting and paperwork', ico.cal],['B','Chasing customers', ico.phone],['C','The actual work', ico.thumb],['D','Everything else nobody sees', ico.repeat]])}
  ${prompt('One letter in the comments')}</div>` },

{ id:'08-while-you-sleep', cls:'cream', inner:()=>`
  <div class="mid"><div class="eyebrow">WHAT THE MONTHLY FEE DOES</div><h1>The work you<br>never see</h1>
  ${rows([['Hosting and uptime','Every day'],['Security monitoring','Every day'],['Backups','Every day'],['SSL kept current','Every day']])}</div>` },

{ id:'09-already-have', cls:'cream', inner:()=>`
  <div class="mid"><div class="split">
    <div><div class="eyebrow">WE HEAR THIS A LOT</div><h2 class="serif">"I already<br>have a<br>website."</h2></div>
    <div>${stats([['Take it over','We manage what you have'],['Or rebuild it','From scratch, if it is past saving'],['Either way','You keep what you paid for']])}</div>
  </div></div>` },

{ id:'10-showcase-galaxy', cls:'ink', footRight:'Salisbury, MD', inner:(d)=>`
  <div class="mid"><div class="eyebrow light">RECENT WORK</div><h1 class="on-ink sm">Galaxy Gymnastics</h1>
  ${browser('galaxygymnast.com', d+'images/case-studies/galaxy-after.webp', 520)}</div>` },

{ id:'11-one-time', cls:'cream', footRight:'No monthly plan', inner:()=>`
  <div class="mid"><div class="eyebrow">PAY ONCE</div><h1>Not everyone wants<br>a monthly plan</h1>
  ${rows([['Quick fix, one page','$149'],['Updates across pages','$299'],['A brand new website','$799'],['You own it all','Included']])}</div>` },

{ id:'12-ask-why-started', cls:'plum', footRight:'We read every reply', inner:()=>`
  <div class="mid"><div class="eyebrow light">TELL US SOMETHING GOOD</div>
  <h1 class="on-plum big">What made you<br>start your<br>business in the<br>first place?</h1>
  ${prompt('We would genuinely like to know')}</div>` },

{ id:'13-ask-google-vs-word', cls:'ink', footRight:'Settle it below', inner:()=>`
  <div class="mid"><div class="eyebrow light">SETTLE A DEBATE</div>
  <h1 class="on-ink sm">Which actually<br>brings you more<br>work?</h1>
  ${options([['A','Showing up on Google', ico.search],['B','Word of mouth', ico.chat],['C','Honestly, both equally', ico.repeat]])}
  ${prompt('Curious what the split looks like')}</div>` },

{ id:'14-autumn', cls:'ink', footRight:'Free preview', inner:()=>`
  <div class="mid"><h1 class="huge on-ink">Cooler months.<br>Quieter phones.<br>Good time to<br><span class="ac">fix that.</span></h1>
  <p class="lede">See a free preview of your new site within 48 hours. No card, no commitment.</p></div>` },

{ id:'15-cta', cls:'plum', footRight:'Free preview in 48 hours', inner:()=>`
  <div class="mid center"><h1 class="on-plum big">Let's get you<br>ready for<br>next season.</h1>
  <div class="cta">webeaze.io</div></div>` },

]};
