const { rows, checks, steps, tags, pills, stats, browser, bars, options, prompt, ico } = require('../lib');

module.exports = {
  label: 'August to September 2026',
  posts: [

{ id:'01-pricing', cls:'cream', inner:()=>`
  <div class="mid"><div class="eyebrow">PLANS</div>
  <h1>What a small business<br>website costs</h1>
  ${rows([['Essential','$169/mo'],['Growth','$249/mo'],['One-time setup','$199'],['Contract','None']])}</div>` },

{ id:'02-mega-price', cls:'ink', footRight:'No contract', inner:()=>`
  <div class="mid center"><div class="eyebrow light">ALL IN, PER MONTH</div>
  <div class="mega">$169</div>
  <p class="lede">Design, hosting, SSL, your domain, unlimited updates,<br>local SEO and someone who picks up.</p></div>` },

{ id:'03-statement', cls:'cream', footRight:'Done for you', inner:()=>`
  <div class="mid"><h1 class="huge">You didn't<br>start a business<br>to build a<br><span class="ac">website.</span></h1>
  <p class="lede">So don't. We build it, host it, update it and keep it working.</p></div>` },

{ id:'04-split', cls:'cream', inner:()=>`
  <div class="mid"><div class="split">
    <div><div class="eyebrow">THE QUESTION</div><h2 class="serif">How long until<br>it is live?</h2></div>
    <div>${stats([['48 hrs','to see a free preview'],['5 to 14','days to build and launch'],['2 days','for most updates after']])}</div>
  </div></div>` },

{ id:'05-included', cls:'cream', inner:()=>`
  <div class="mid"><div class="eyebrow">ONE PRICE</div><h1>Everything<br>included</h1>
  ${checks(['Custom design, built for your business','Hosting, SSL and domain management','Unlimited content updates','Local SEO and Google Business Profile','A real person to call'])}</div>` },

{ id:'06-steps', cls:'plum', footRight:'Free preview', inner:()=>`
  <div class="mid"><div class="eyebrow light">HOW IT WORKS</div><h1 class="on-plum">Three steps,<br>no paperwork</h1>
  ${steps([['01','Book a short call','Fifteen minutes, no pitch.'],['02','See a free preview','Your real site, within 48 hours.'],['03','Approve and go live','Live in 5 to 14 days.']])}</div>` },

{ id:'07-quote', cls:'cream', inner:(d)=>`
  <div class="mid"><div class="eyebrow">CLIENT</div>
  <blockquote class="quote">Great people to work with, very responsive. All the work was done on time.</blockquote>
  <div class="who"><img src="${d}images/assets/anthony-blanche.webp" alt=""><div><b>Anthony B.</b><span>WebEaze client</span></div></div></div>` },

{ id:'08-showcase', cls:'ink', footRight:'Dover, DE', inner:(d)=>`
  <div class="mid"><div class="eyebrow light">RECENT WORK</div><h1 class="on-ink sm">Grass Goats<br>Lawn Care</h1>
  ${browser('grassgoats.com', d+'images/case-studies/grassgoats-after.webp')}</div>` },

{ id:'09-bars', cls:'cream', inner:()=>`
  <div class="mid"><div class="eyebrow">UPFRONT COST</div><h1>What everyone<br>else charges</h1>
  ${bars([['Agency','100%','$5k to $25k'],['Freelancer','42%','$1.5k to $8k'],['WebEaze','5%','$199',true]])}</div>` },

// Discussion starter: an A/B/C/D question people can answer with one letter.
{ id:'10-ask-customers', cls:'cream', footRight:'Tell us below', inner:()=>`
  <div class="qmark">?</div>
  <div class="mid"><div class="eyebrow">HONEST QUESTION</div>
  <h1 class="sm">Where do your<br>customers actually<br>come from?</h1>
  ${options([['A','Google search', ico.search],['B','Word of mouth', ico.chat],['C','Facebook or Instagram', ico.thumb],['D','Repeat customers', ico.repeat]])}
  ${prompt('Drop your letter in the comments')}</div>` },

{ id:'11-unlimited', cls:'plum', footRight:'Every plan', inner:()=>`
  <div class="mid center"><div class="mega on-plum">Unlimited</div>
  <p class="lede on-plum-sub">New hours. New photos. New prices. A whole new page.<br>Just send a message.</p></div>` },

{ id:'12-ask-last-update', cls:'ink', footRight:'No judgement', inner:()=>`
  <div class="mid"><div class="eyebrow light">BE HONEST</div>
  <h1 class="on-ink sm">When did you last<br>update your website?</h1>
  ${options([['A','This month', ico.spark],['B','Sometime this year', ico.cal],['C','I genuinely cannot remember', ico.dust],['D','I do not have one yet', ico.phone]])}
  ${prompt('Nobody is judging. Mostly.')}</div>` },

{ id:'13-who', cls:'cream', inner:()=>`
  <div class="mid"><div class="eyebrow">WHO WE BUILD FOR</div><h1>Businesses that<br>do the work</h1>
  ${tags(['Landscapers','Carpet cleaners','Restaurants','Gyms','Salons','Contractors','Clinics','Tutors','Trades'])}</div>` },

{ id:'14-ask-one-fix', cls:'plum', footRight:'We read every reply', inner:()=>`
  <div class="mid"><div class="eyebrow light">OVER TO YOU</div>
  <h1 class="on-plum big">If you could fix<br>one thing about<br>your website<br>tomorrow, what<br>would it be?</h1>
  ${prompt('Tell us in the comments')}</div>` },

{ id:'15-cta', cls:'plum', footRight:'Free preview in 48 hours', inner:()=>`
  <div class="mid center"><h1 class="on-plum big">Let's see what<br>yours could<br>look like.</h1>
  <div class="cta">webeaze.io</div></div>` },

// Labor Day, Monday September 7 2026. Photo-backed, copy left-aligned and bottom-weighted.
{ id:'16-labor-day', cls:'ink', bg:'images/construction-worker.png', footRight:'Back Tuesday', inner:()=>`
  <div class="mid">
    <div class="eyebrow">MONDAY, SEPTEMBER 7</div>
    <h1 class="big">Happy<br>Labor Day</h1>
    <p class="lede">To everyone working through the long weekend.<br>The mowing, the cleaning, the kitchens, the job sites.</p>
    <p class="lede sm">Our office is closed for the holiday. Send a request any time and we will pick it up Tuesday.</p>
  </div>` },

]};
