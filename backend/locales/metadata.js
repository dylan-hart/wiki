/**
 * Language metadata for every locale vendored under `backend/locales/`.
 *
 * This file is generated output (see `backend/locales/metadata.d.ts` and `localazy.json`).
 * `language`/`region`/`script`/`isRtl`/`name`/`localizedName` come straight from
 * requarks/wiki-locales' `locales/metadata.json` (the `sr-Latn` entry is added by hand -- that
 * repo's own metadata.json omits it even though `sr-Latn.json` exists as a downloadable file).
 *
 * `pluralType` is NOT produced by that metadata.json (JSON can't hold functions, and Localazy's
 * own CLI only generates this field in its `.js`/`.mjs` download output, which requires a
 * Localazy account/project token this environment does not have). It is filled in here from a
 * hand-built CLDR-standard plural-rule lookup table (see the generation script), grouped into the
 * same family shapes CLDR itself groups these languages into. `pluralType` is currently unused
 * by this codebase (confirmed by grep) -- kept only for shape-compatibility with the
 * `LocalazyLanguage` interface in `metadata.d.ts`.
 *
 * The `files` block below is a static remnant of the Localazy CDN URLs recorded the last time
 * this file was actually produced by the Localazy CLI; it is inert (nothing reads it at runtime)
 * and is left as-is rather than fabricated for the 50 languages added here.
 */
const localazyMetadata = {
  projectUrl: "https://localazy.com/p/wiki",
  baseLocale: "en",
  languages: [
    {
      language: "af",
      region: "",
      script: "",
      isRtl: false,
      name: "Afrikaans",
      localizedName: "Afrikaans",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "am",
      region: "",
      script: "",
      isRtl: false,
      name: "Amharic",
      localizedName: "አማርኛ",
      pluralType: (n) => { return (n===0 || n===1) ? "one" : "other"; }
    },
    {
      language: "ar",
      region: "",
      script: "",
      isRtl: true,
      name: "Arabic",
      localizedName: "العربية",
      pluralType: (n) => { return (n===0) ? "zero" : (n===1) ? "one" : (n===2) ? "two" : (n%100>=3 && n%100<=10) ? "few" : (n%100>=11 && n%100<=99) ? "many" : "other"; }
    },
    {
      language: "az",
      region: "",
      script: "",
      isRtl: false,
      name: "Azerbaijani",
      localizedName: "Azərbaycan",
      pluralType: (n) => { return (n%10===1 && n%100!==11) ? "one" : "other"; }
    },
    {
      language: "bg",
      region: "",
      script: "",
      isRtl: false,
      name: "Bulgarian",
      localizedName: "Български",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "bs",
      region: "",
      script: "",
      isRtl: false,
      name: "Bosnian",
      localizedName: "Bosanski",
      pluralType: (n) => { return ((n%10===1) && (n%100!==11)) ? "one" : ((n%10>=2 && n%10<=4) && ((n%100<12 || n%100>14))) ? "few" : "many"; }
    },
    {
      language: "ca",
      region: "",
      script: "",
      isRtl: false,
      name: "Catalan",
      localizedName: "Català",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "cs",
      region: "",
      script: "",
      isRtl: false,
      name: "Czech",
      localizedName: "Čeština",
      pluralType: (n) => { return (n===1) ? "one" : (n>=2 && n<=4) ? "few" : "other"; }
    },
    {
      language: "da",
      region: "",
      script: "",
      isRtl: false,
      name: "Danish",
      localizedName: "Dansk",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "de",
      region: "",
      script: "",
      isRtl: false,
      name: "German",
      localizedName: "Deutsch",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "el",
      region: "",
      script: "",
      isRtl: false,
      name: "Greek",
      localizedName: "Ελληνικά",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "en",
      region: "",
      script: "",
      isRtl: false,
      name: "English",
      localizedName: "English",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "es",
      region: "",
      script: "",
      isRtl: false,
      name: "Spanish",
      localizedName: "Español",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "et",
      region: "",
      script: "",
      isRtl: false,
      name: "Estonian",
      localizedName: "Eesti",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "eu",
      region: "",
      script: "",
      isRtl: false,
      name: "Basque",
      localizedName: "Euskara",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "fa",
      region: "",
      script: "",
      isRtl: true,
      name: "Persian",
      localizedName: "فارسی",
      pluralType: (n) => { return (n===0 || n===1) ? "one" : "other"; }
    },
    {
      language: "fi",
      region: "",
      script: "",
      isRtl: false,
      name: "Finnish",
      localizedName: "Suomi",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "fr",
      region: "",
      script: "",
      isRtl: false,
      name: "French",
      localizedName: "Français",
      pluralType: (n) => { return (n===0 || n===1) ? "one" : "other"; }
    },
    {
      language: "gu",
      region: "",
      script: "",
      isRtl: false,
      name: "Gujarati",
      localizedName: "ગુજરાતી",
      pluralType: (n) => { return (n===0 || n===1) ? "one" : "other"; }
    },
    {
      language: "he",
      region: "",
      script: "",
      isRtl: true,
      name: "Hebrew",
      localizedName: "עברית",
      pluralType: (n) => { return (n===1) ? "one" : (n===2) ? "two" : "other"; }
    },
    {
      language: "hi",
      region: "",
      script: "",
      isRtl: false,
      name: "Hindi",
      localizedName: "हिन्दी",
      pluralType: (n) => { return (n===0 || n===1) ? "one" : "other"; }
    },
    {
      language: "ht",
      region: "",
      script: "",
      isRtl: false,
      name: "Haitian Creole",
      localizedName: "Haitian Creole",
      pluralType: (n) => { return "other"; }
    },
    {
      language: "hu",
      region: "",
      script: "",
      isRtl: false,
      name: "Hungarian",
      localizedName: "Magyar",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "hy",
      region: "",
      script: "",
      isRtl: false,
      name: "Armenian",
      localizedName: "Հայերեն",
      pluralType: (n) => { return (n===0 || n===1) ? "one" : "other"; }
    },
    {
      language: "id",
      region: "",
      script: "",
      isRtl: false,
      name: "Indonesian",
      localizedName: "Indonesia",
      pluralType: (n) => { return "other"; }
    },
    {
      language: "is",
      region: "",
      script: "",
      isRtl: false,
      name: "Icelandic",
      localizedName: "Íslenska",
      pluralType: (n) => { return (n%10===1 && n%100!==11) ? "one" : "other"; }
    },
    {
      language: "it",
      region: "",
      script: "",
      isRtl: false,
      name: "Italian",
      localizedName: "Italiano",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "ja",
      region: "",
      script: "",
      isRtl: false,
      name: "Japanese",
      localizedName: "日本語",
      pluralType: (n) => { return "other"; }
    },
    {
      language: "kk",
      region: "",
      script: "",
      isRtl: false,
      name: "Kazakh",
      localizedName: "Қазақ Тілі",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "km",
      region: "KH",
      script: "",
      isRtl: false,
      name: "Khmer (Cambodia)",
      localizedName: "ខ្មែរ (កម្ពុជា)",
      pluralType: (n) => { return "other"; }
    },
    {
      language: "ko",
      region: "",
      script: "",
      isRtl: false,
      name: "Korean",
      localizedName: "한국어",
      pluralType: (n) => { return "other"; }
    },
    {
      language: "lt",
      region: "",
      script: "",
      isRtl: false,
      name: "Lithuanian",
      localizedName: "Lietuvių",
      pluralType: (n) => { return (n%10===1 && !(n%100>=11 && n%100<=19)) ? "one" : (n%10>=2 && n%10<=9 && !(n%100>=11 && n%100<=19)) ? "few" : "other"; }
    },
    {
      language: "lv",
      region: "",
      script: "",
      isRtl: false,
      name: "Latvian",
      localizedName: "Latviešu",
      pluralType: (n) => { return (n%10===0 || (n%100>=11 && n%100<=19)) ? "zero" : (n%10===1 && n%100!==11) ? "one" : "other"; }
    },
    {
      language: "mk",
      region: "",
      script: "",
      isRtl: false,
      name: "Macedonian",
      localizedName: "Македонски",
      pluralType: (n) => { return (n%10===1 && n%100!==11) ? "one" : "other"; }
    },
    {
      language: "mn",
      region: "",
      script: "",
      isRtl: false,
      name: "Mongolian",
      localizedName: "Монгол",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "nb",
      region: "",
      script: "",
      isRtl: false,
      name: "Norwegian Bokmål",
      localizedName: "Norsk Bokmål",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "nl",
      region: "",
      script: "",
      isRtl: false,
      name: "Dutch",
      localizedName: "Nederlands",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "nn",
      region: "",
      script: "",
      isRtl: false,
      name: "Norwegian Nynorsk",
      localizedName: "Nynorsk",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "pl",
      region: "",
      script: "",
      isRtl: false,
      name: "Polish",
      localizedName: "Polski",
      pluralType: (n) => { return (n===1) ? "one" : (n%10>=2 && n%10<=4 && !(n%100>=12 && n%100<=14)) ? "few" : "many"; }
    },
    {
      language: "pt",
      region: "BR",
      script: "",
      isRtl: false,
      name: "Brazilian Portuguese",
      localizedName: "Português (Brasil)",
      pluralType: (n) => { return (n===0 || n===1) ? "one" : "other"; }
    },
    {
      language: "ro",
      region: "",
      script: "",
      isRtl: false,
      name: "Romanian",
      localizedName: "Română",
      pluralType: (n) => { return (n===1) ? "one" : (n===0 || (n%100>=2 && n%100<=19)) ? "few" : "other"; }
    },
    {
      language: "ru",
      region: "",
      script: "",
      isRtl: false,
      name: "Russian",
      localizedName: "Русский",
      pluralType: (n) => { return ((n%10===1) && (n%100!==11)) ? "one" : ((n%10>=2 && n%10<=4) && ((n%100<12 || n%100>14))) ? "few" : "many"; }
    },
    {
      language: "si",
      region: "",
      script: "",
      isRtl: false,
      name: "Sinhala",
      localizedName: "සිංහල",
      pluralType: (n) => { return (n===0 || n===1) ? "one" : "other"; }
    },
    {
      language: "sk",
      region: "",
      script: "",
      isRtl: false,
      name: "Slovak",
      localizedName: "Slovenčina",
      pluralType: (n) => { return (n===1) ? "one" : (n>=2 && n<=4) ? "few" : "other"; }
    },
    {
      language: "sl",
      region: "",
      script: "",
      isRtl: false,
      name: "Slovenian",
      localizedName: "Slovenščina",
      pluralType: (n) => { return (n%100===1) ? "one" : (n%100===2) ? "two" : (n%100===3 || n%100===4) ? "few" : "other"; }
    },
    {
      language: "sr",
      region: "",
      script: "",
      isRtl: false,
      name: "Serbian",
      localizedName: "Српски",
      pluralType: (n) => { return ((n%10===1) && (n%100!==11)) ? "one" : ((n%10>=2 && n%10<=4) && ((n%100<12 || n%100>14))) ? "few" : "many"; }
    },
    {
      language: "sr",
      region: "",
      script: "Latn",
      isRtl: false,
      name: "Serbian (Latin)",
      localizedName: "Srpski (latinica)",
      pluralType: (n) => { return ((n%10===1) && (n%100!==11)) ? "one" : ((n%10>=2 && n%10<=4) && ((n%100<12 || n%100>14))) ? "few" : "many"; }
    },
    {
      language: "sv",
      region: "",
      script: "",
      isRtl: false,
      name: "Swedish",
      localizedName: "Svenska",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "ta",
      region: "",
      script: "",
      isRtl: false,
      name: "Tamil",
      localizedName: "தமிழ்",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "th",
      region: "",
      script: "",
      isRtl: false,
      name: "Thai",
      localizedName: "ไทย",
      pluralType: (n) => { return "other"; }
    },
    {
      language: "tr",
      region: "",
      script: "",
      isRtl: false,
      name: "Turkish",
      localizedName: "Türkçe",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "ug",
      region: "",
      script: "",
      isRtl: true,
      name: "Uyghur",
      localizedName: "ئۇيغۇرچە",
      pluralType: (n) => { return (n===1) ? "one" : "other"; }
    },
    {
      language: "uk",
      region: "",
      script: "",
      isRtl: false,
      name: "Ukrainian",
      localizedName: "Українська",
      pluralType: (n) => { return ((n%10===1) && (n%100!==11)) ? "one" : ((n%10>=2 && n%10<=4) && ((n%100<12 || n%100>14))) ? "few" : "many"; }
    },
    {
      language: "vi",
      region: "",
      script: "",
      isRtl: false,
      name: "Vietnamese",
      localizedName: "Tiếng Việt",
      pluralType: (n) => { return "other"; }
    },
    {
      language: "zh",
      region: "",
      script: "Hans",
      isRtl: false,
      name: "Simplified Chinese",
      localizedName: "简体中文",
      pluralType: (n) => { return "other"; }
    },
    {
      language: "zh",
      region: "",
      script: "Hant",
      isRtl: false,
      name: "Traditional Chinese",
      localizedName: "繁體中文",
      pluralType: (n) => { return "other"; }
    }
  ],
  files: [
    {
      cdnHash: "54b977214afbffe2ffeb07d0ccb03558e75e4408",
      file: "file.json",
      path: "",
      library: "",
      module: "",
      buildType: "",
      productFlavors: [],
      cdnFiles: {
        "de#": "https://delivery.localazy.com/_a7797965569058078203416ae5aa/_e0/54b977214afbffe2ffeb07d0ccb03558e75e4408/de/file.json",
        "en#": "https://delivery.localazy.com/_a7797965569058078203416ae5aa/_e0/54b977214afbffe2ffeb07d0ccb03558e75e4408/en/file.json",
        "fr#": "https://delivery.localazy.com/_a7797965569058078203416ae5aa/_e0/54b977214afbffe2ffeb07d0ccb03558e75e4408/fr/file.json",
        "pt_BR#": "https://delivery.localazy.com/_a7797965569058078203416ae5aa/_e0/54b977214afbffe2ffeb07d0ccb03558e75e4408/pt-BR/file.json",
        "ru#": "https://delivery.localazy.com/_a7797965569058078203416ae5aa/_e0/54b977214afbffe2ffeb07d0ccb03558e75e4408/ru/file.json",
        "zh#Hans": "https://delivery.localazy.com/_a7797965569058078203416ae5aa/_e0/54b977214afbffe2ffeb07d0ccb03558e75e4408/zh-Hans/file.json"
      }
    }
  ]
};

export default localazyMetadata;
