const { leadSpamCheck } = require(process.env.SP + '/spamcheck.js');
const SPAM = [
 ['freelance writer','Hey! Do you have any use for a freelance writer? I have nearly a decade of experience and can help with pretty much any type of content, including blog posts, case studies, press releases, thought leadership, articles, and much more. I am currently looking for new opportunities and would love to see if you have any writing projects I could help with. You can book a time with me to chat if interested. Hoping to connect! https://calendly.com/melottogroup/30min'],
 ['SEO agency','Hi, I noticed your website isnt ranking on page 1 for your main keywords. We are a digital marketing agency and can get you to the top of Google. Book a 15 minute call.'],
 ['web design pitch','Hello, we build modern websites starting at $499. Would you be open to a quick chat this week?'],
 ['VA cold pitch','Hi there! I am a virtual assistant with 5 years of experience. My services include inbox management, scheduling and data entry. My rates are very competitive. Let me know!'],
 ['designer + calendly','Im a designer open to new opportunities. Portfolio and rates here, grab a slot: https://cal.com/jsmith/15min'],
 ['crypto','Double your investment with our guaranteed returns trading bot. Passive income starts today!'],
 ['shortened link','Hi, saw your site. We can help you grow. More info here: https://bit.ly/3xKp2'],
];
const REAL = [
 ['gutter quote','Hi, I need a quote for the gutters on a two storey house in Coral Gables. Roughly how soon could someone come out and take a look?'],
 ['carpet clean','Do you clean wool rugs? I have a 9x12 in the living room that the dog got to. I am in Harrisburg.'],
 ['booking question','Can I book a class for my daughter on Saturday mornings? She is 7 and has never done gymnastics.'],
 ['price question','What do you charge for a 3 bedroom house? Also do you accept bitcoin?'],
 ['short real one','Do you do tile and grout? Kitchen floor, about 200 sq ft.'],
 ['writer as CUSTOMER','I am a freelance writer and I need a simple portfolio website built. Can you help?'],
 ['asks to book US','Can I book a time to talk about a new website? I am free Thursday.'],
 ['VA who is buying','I am a virtual assistant and I need a website for my services. How much would that cost?'],
 ['terse','need my gutters cleaned, how much'],
 ['do you have hours','Do you have availability on Saturday? Need a deep clean before we move in.'],
 ['wants a revamp','Our website is old and does not show up on Google. Can you redesign it? What would it cost?'],
 ['angry customer','Your website form was broken all week and I could not book. Very frustrating, please fix.'],
 ['long real one','Hi, we run a small dental practice in Dover and our current site is five years old. We would like something modern that lets patients book online, and we need it to work well on phones. What sort of budget should we be thinking about, and how long does it usually take?'],
];
let bad = 0;
console.log('\n  SPAM:');
SPAM.forEach(([l, m]) => { const r = leadSpamCheck({ message: m, email: '', name: '' }); if (!r.spam) bad++;
  console.log('    ' + (r.spam ? 'ok  ' : 'MISS').padEnd(5) + String(r.score).padStart(3) + '  ' + l.padEnd(20) + (r.why.length ? '(' + r.why.join(', ') + ')' : '')); });
console.log('\n  REAL:');
REAL.forEach(([l, m]) => { const r = leadSpamCheck({ message: m, email: '', name: '' }); if (r.spam) bad++;
  console.log('    ' + (!r.spam ? 'ok  ' : 'FALSE').padEnd(5) + String(r.score).padStart(3) + '  ' + l.padEnd(20) + (r.why.length ? '(' + r.why.join(', ') + ')' : '')); });
console.log('\n  ' + (bad ? bad + ' WRONG' : 'all ' + (SPAM.length + REAL.length) + ' correct'));
