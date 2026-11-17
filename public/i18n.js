/* Languages for players and spectators: English, Tamil, Telugu, Hindi, Kannada, Malayalam.
   The app is written in English; this file swaps known phrases for their translations after each screen is drawn.
   Names, scores and anything typed by people are never touched. Translations are a first draft and
   should be checked by native speakers before the event (see README). */
(function () {
  const L = ['en', 'ta', 'te', 'hi', 'kn', 'ml'];
  const NAMES = { en: 'English', ta: 'தமிழ்', te: 'తెలుగు', hi: 'हिन्दी', kn: 'ಕನ್ನಡ', ml: 'മലയാളം' };
  /* phrase: [ta, te, hi, kn, ml] */
  const D = {
    'Home': ['முகப்பு', 'హోమ్', 'होम', 'ಮುಖಪುಟ', 'ഹോം'],
    'Matches': ['போட்டிகள்', 'మ్యాచ్‌లు', 'मैच', 'ಪಂದ್ಯಗಳು', 'മത്സരങ്ങൾ'],
    'Players': ['வீரர்கள்', 'ఆటగాళ్లు', 'खिलाड़ी', 'ಆಟಗಾರರು', 'കളിക്കാർ'],
    'Gallery': ['படத்தொகுப்பு', 'గ్యాలరీ', 'गैलरी', 'ಗ್ಯಾಲರಿ', 'ഗാലറി'],
    'Menu': ['பட்டி', 'మెనూ', 'मेन्यू', 'ಮೆನು', 'മെനു'],
    'Live now': ['இப்போது நேரலை', 'ఇప్పుడు లైవ్', 'अभी लाइव', 'ಈಗ ಲೈವ್', 'ഇപ്പോൾ തത്സമയം'],
    'Events': ['போட்டிப் பிரிவுகள்', 'ఈవెంట్లు', 'स्पर्धाएँ', 'ಸ್ಪರ್ಧೆಗಳು', 'ഇനങ്ങൾ'],
    'Up next': ['அடுத்து', 'తదుపరి', 'अगला', 'ಮುಂದಿನದು', 'അടുത്തത്'],
    'Recent results': ['சமீபத்திய முடிவுகள்', 'ఇటీవలి ఫలితాలు', 'हाल के नतीजे', 'ಇತ್ತೀಚಿನ ಫಲಿತಾಂಶಗಳು', 'സമീപകാല ഫലങ്ങൾ'],
    'Not started': ['தொடங்கவில்லை', 'ప్రారంభం కాలేదు', 'शुरू नहीं हुआ', 'ಪ್ರಾರಂಭವಾಗಿಲ್ಲ', 'ആരംഭിച്ചിട്ടില്ല'],
    'Adults': ['பெரியவர்கள்', 'పెద్దలు', 'वयस्क', 'ವಯಸ್ಕರು', 'മുതിർന്നവർ'],
    'Kids': ['சிறுவர்கள்', 'పిల్లలు', 'बच्चे', 'ಮಕ್ಕಳು', 'കുട്ടികൾ'],
    '● LIVE': ['● நேரலை', '● లైవ్', '● लाइव', '● ಲೈವ್', '● തത്സമയം'],
    'Full time': ['ஆட்டம் முடிந்தது', 'మ్యాచ్ ముగిసింది', 'मैच समाप्त', 'ಪಂದ್ಯ ಮುಗಿದಿದೆ', 'മത്സരം കഴിഞ്ഞു'],
    'Upcoming': ['வரவிருக்கும்', 'రాబోయే', 'आगामी', 'ಮುಂಬರುವ', 'വരാനിരിക്കുന്നത്'],
    'Live': ['நேரலை', 'లైవ్', 'लाइव', 'ಲೈವ್', 'തത്സമയം'],
    'Completed': ['முடிந்தவை', 'పూర్తయినవి', 'पूर्ण', 'ಪೂರ್ಣಗೊಂಡಿದೆ', 'പൂർത്തിയായി'],
    'Any status': ['எந்த நிலையும்', 'ఏ స్థితి అయినా', 'कोई भी स्थिति', 'ಯಾವುದೇ ಸ್ಥಿತಿ', 'ഏത് നിലയും'],
    'All events': ['அனைத்துப் பிரிவுகள்', 'అన్ని ఈవెంట్లు', 'सभी स्पर्धाएँ', 'ಎಲ್ಲಾ ಸ್ಪರ್ಧೆಗಳು', 'എല്ലാ ഇനങ്ങളും'],
    'List': ['பட்டியல்', 'జాబితా', 'सूची', 'ಪಟ್ಟಿ', 'പട്ടിക'],
    'Schedule': ['அட்டவணை', 'షెడ్యూల్', 'कार्यक्रम', 'ವೇಳಾಪಟ್ಟಿ', 'ഷെഡ്യൂൾ'],
    'No matches yet.': ['இன்னும் போட்டிகள் இல்லை.', 'ఇంకా మ్యాచ్‌లు లేవు.', 'अभी कोई मैच नहीं।', 'ಇನ್ನೂ ಪಂದ್ಯಗಳಿಲ್ಲ.', 'ഇതുവരെ മത്സരങ്ങളില്ല.'],
    'Games': ['ஆட்டங்கள்', 'గేమ్‌లు', 'गेम', 'ಗೇಮ್‌ಗಳು', 'ഗെയിമുകൾ'],
    'Standings': ['புள்ளிப்பட்டியல்', 'పట్టిక', 'अंक तालिका', 'ಅಂಕಪಟ್ಟಿ', 'പോയിന്റ് നില'],
    'Winner': ['வெற்றியாளர்', 'విజేత', 'विजेता', 'ವಿಜೇತ', 'വിജയി'],
    'Updates': ['புதுப்பிப்புகள்', 'అప్‌డేట్‌లు', 'अपडेट', 'ಅಪ್‌ಡೇಟ್‌ಗಳು', 'അപ്‌ഡേറ്റുകൾ'],
    'Notifications': ['அறிவிப்புகள்', 'నోటిఫికేషన్లు', 'सूचनाएँ', 'ಅಧಿಸೂಚನೆಗಳು', 'അറിയിപ്പുകൾ'],
    'Match alerts': ['போட்டி அறிவிப்புகள்', 'మ్యాచ్ అలర్ట్‌లు', 'मैच अलर्ट', 'ಪಂದ್ಯ ಎಚ್ಚರಿಕೆಗಳು', 'മത്സര അലേർട്ടുകൾ'],
    'Turn on alerts': ['அறிவிப்புகளை இயக்கு', 'అలర్ట్‌లను ఆన్ చేయండి', 'अलर्ट चालू करें', 'ಎಚ್ಚರಿಕೆಗಳನ್ನು ಆನ್ ಮಾಡಿ', 'അലേർട്ടുകൾ ഓണാക്കുക'],
    'Turn on': ['இயக்கு', 'ఆన్ చేయండి', 'चालू करें', 'ಆನ್ ಮಾಡಿ', 'ഓണാക്കുക'],
    'Turn off': ['நிறுத்து', 'ఆఫ్ చేయండి', 'बंद करें', 'ಆಫ್ ಮಾಡಿ', 'ഓഫാക്കുക'],
    'Not now': ['இப்போது வேண்டாம்', 'ఇప్పుడు వద్దు', 'अभी नहीं', 'ಈಗ ಬೇಡ', 'ഇപ്പോൾ വേണ്ട'],
    'Sign in': ['உள்நுழை', 'సైన్ ఇన్', 'साइन इन', 'ಸೈನ್ ಇನ್', 'സൈൻ ഇൻ'],
    'Sign out': ['வெளியேறு', 'సైన్ అవుట్', 'साइन आउट', 'ಸೈನ್ ಔಟ್', 'സൈൻ ഔട്ട്'],
    'Register': ['பதிவு செய்', 'నమోదు', 'पंजीकरण करें', 'ನೋಂದಣಿ', 'രജിസ്റ്റർ'],
    'Register as a player': ['வீரராகப் பதிவு செய்', 'ఆటగాడిగా నమోదు చేసుకోండి', 'खिलाड़ी के रूप में पंजीकरण करें', 'ಆಟಗಾರರಾಗಿ ನೋಂದಾಯಿಸಿ', 'കളിക്കാരനായി രജിസ്റ്റർ ചെയ്യുക'],
    'Full name': ['முழுப் பெயர்', 'పూర్తి పేరు', 'पूरा नाम', 'ಪೂರ್ಣ ಹೆಸರು', 'മുഴുവൻ പേര്'],
    'Phone': ['தொலைபேசி', 'ఫోన్', 'फ़ोन', 'ಫೋನ್', 'ഫോൺ'],
    'Email': ['மின்னஞ்சல்', 'ఇమెయిల్', 'ईमेल', 'ಇಮೇಲ್', 'ഇമെയിൽ'],
    'Events you want to play': ['நீங்கள் விளையாட விரும்பும் பிரிவுகள்', 'మీరు ఆడాలనుకునే ఈవెంట్లు', 'जिन स्पर्धाओं में खेलना चाहते हैं', 'ನೀವು ಆಡಲು ಬಯಸುವ ಸ್ಪರ್ಧೆಗಳು', 'നിങ്ങൾ കളിക്കാൻ ആഗ്രഹിക്കുന്ന ഇനങ്ങൾ'],
    'Join code': ['சேர்க்கை குறியீடு', 'జాయిన్ కోడ్', 'जुड़ने का कोड', 'ಸೇರ್ಪಡೆ ಕೋಡ್', 'ജോയിൻ കോഡ്'],
    'Submit registration': ['பதிவைச் சமர்ப்பி', 'నమోదును సమర్పించండి', 'पंजीकरण जमा करें', 'ನೋಂದಣಿ ಸಲ್ಲಿಸಿ', 'രജിസ്ട്രേഷൻ സമർപ്പിക്കുക'],
    'You are registered!': ['நீங்கள் பதிவு செய்யப்பட்டுள்ளீர்கள்!', 'మీరు నమోదు అయ్యారు!', 'आपका पंजीकरण हो गया है!', 'ನೀವು ನೋಂದಾಯಿಸಲ್ಪಟ್ಟಿದ್ದೀರಿ!', 'നിങ്ങൾ രജിസ്റ്റർ ചെയ്തു!'],
    'Language': ['மொழி', 'భాష', 'भाषा', 'ಭಾಷೆ', 'ഭാഷ'],
    'Female': ['பெண்', 'స్త్రీ', 'महिला', 'ಮಹಿಳೆ', 'സ്ത്രീ'],
    'Male': ['ஆண்', 'పురుషుడు', 'पुरुष', 'ಪುರುಷ', 'പുരുഷൻ'],
    'Big-screen mode': ['பெரிய திரை முறை', 'పెద్ద స్క్రీన్ మోడ్', 'बड़ी स्क्रीन मोड', 'ದೊಡ್ಡ ಪರದೆ ಮೋಡ್', 'വലിയ സ്‌ക്രീൻ മോഡ്'],
    'My profile': ['என் சுயவிவரம்', 'నా ప్రొఫైల్', 'मेरी प्रोफ़ाइल', 'ನನ್ನ ಪ್ರೊಫೈಲ್', 'എന്റെ പ്രൊഫൈൽ'],
    'Loading…': ['ஏற்றுகிறது…', 'లోడ్ అవుతోంది…', 'लोड हो रहा है…', 'ಲೋಡ್ ಆಗುತ್ತಿದೆ…', 'ലോഡ് ചെയ്യുന്നു…'],
    'Save': ['சேமி', 'సేవ్', 'सहेजें', 'ಉಳಿಸಿ', 'സേവ് ചെയ്യുക'],
    'Cancel': ['ரத்து', 'రద్దు', 'रद्द करें', 'ರದ್ದುಮಾಡಿ', 'റദ്ദാക്കുക'],
    'Close': ['மூடு', 'మూసివేయి', 'बंद करें', 'ಮುಚ್ಚಿ', 'അടയ്ക്കുക'],
  };
  /* phrases with numbers or names inside */
  const PAT = [
    [/^Round (\d+) of (\d+)$/, { ta: 'சுற்று $1/$2', te: 'రౌండ్ $1/$2', hi: 'राउंड $1/$2', kn: 'ಸುತ್ತು $1/$2', ml: 'റൗണ്ട് $1/$2' }],
    [/^Round (\d+)$/, { ta: 'சுற்று $1', te: 'రౌండ్ $1', hi: 'राउंड $1', kn: 'ಸುತ್ತು $1', ml: 'റൗണ്ട് $1' }],
    [/^Game (\d+) of (\d+)/, { ta: 'ஆட்டம் $1/$2', te: 'గేమ్ $1/$2', hi: 'गेम $1/$2', kn: 'ಗೇಮ್ $1/$2', ml: 'ഗെയിം $1/$2' }],
    [/^Game (\d+)$/, { ta: 'ஆட்டம் $1', te: 'గేమ్ $1', hi: 'गेम $1', kn: 'ಗೇಮ್ $1', ml: 'ഗെയിം $1' }],
    [/^Referee: (.+)$/, { ta: 'நடுவர்: $1', te: 'రిఫరీ: $1', hi: 'रेफरी: $1', kn: 'ರೆಫರಿ: $1', ml: 'റഫറി: $1' }],
    [/^(\d+) players$/, { ta: '$1 வீரர்கள்', te: '$1 ఆటగాళ్లు', hi: '$1 खिलाड़ी', kn: '$1 ಆಟಗಾರರು', ml: '$1 കളിക്കാർ' }],
    [/^(\d+) teams$/, { ta: '$1 அணிகள்', te: '$1 జట్లు', hi: '$1 टीमें', kn: '$1 ತಂಡಗಳು', ml: '$1 ടീമുകൾ' }],
  ];
  let lang = 'en'; try { lang = localStorage.getItem('lang') || 'en'; } catch (e) { /* private mode */ }
  if (!L.includes(lang)) lang = 'en';
  const idx = (l) => L.indexOf(l) - 1;
  const SKIP = ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION'];
  const tr = (s) => {
    if (lang === 'en') return s;
    const core = s.trim(); if (!core) return s;
    const lead = s.slice(0, s.indexOf(core)), tail = s.slice(s.indexOf(core) + core.length);
    if (D[core]) return lead + D[core][idx(lang)] + tail;
    for (const [re, o] of PAT) if (re.test(core)) return lead + core.replace(re, o[lang]) + tail;
    return s;
  };
  let busy = false;
  function walk(root) {
    if (busy || !root) return; busy = true;
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentNode && SKIP.includes(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
      nodes.forEach((n) => {
        if (n.__en === undefined || (n.__tr !== n.nodeValue)) n.__en = n.nodeValue;     /* new text written by the app */
        const out = tr(n.__en); if (out !== n.nodeValue) n.nodeValue = out; n.__tr = n.nodeValue;
      });
      root.querySelectorAll('[placeholder],[aria-label],[title]').forEach((el) => ['placeholder', 'aria-label', 'title'].forEach((a) => {
        const v = el.getAttribute(a); if (v == null) return;
        const k = '__en_' + a; if (el[k] === undefined || el[k + 't'] !== v) el[k] = v;
        const out = tr(el[k]); if (out !== v) el.setAttribute(a, out); el[k + 't'] = out;
      }));
    } finally { busy = false; }
  }
  let timer = null;
  const schedule = () => { if (lang === 'en' && !document.__langWas) return; clearTimeout(timer); timer = setTimeout(() => walk(document.body), 30); };
  new MutationObserver(() => { if (!busy) schedule(); }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  function set(l) {
    if (!L.includes(l)) return;
    document.__langWas = document.__langWas || lang !== 'en' || l !== 'en';
    lang = l; try { localStorage.setItem('lang', l); } catch (e) { /* ignore */ }
    document.documentElement.lang = l; walk(document.body);
  }
  document.documentElement.lang = lang; if (lang !== 'en') document.__langWas = true;
  window.I18N = { langs: L, names: NAMES, get lang() { return lang; }, set, tr };
})();
