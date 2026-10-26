// OpenFrance — Pollens (2/2) : vue « Essences & exposition » (structurelle, PAR DÉPARTEMENT).
//
// Complément de pollens.js (indice quotidien par commune) : où vit-on, « en
// général », à proximité de quelles essences allergisantes ? Objectif :
// comparaison de régions pour un projet de déménagement. Sélecteur « Vue »
// dans le mode Pollens : « Indice quotidien » (pollens.js) | « Essences &
// exposition » (ce fichier). Aucune modification d'app.js, score.js,
// annuaire.js ni pollens.js : auto-câblage modèle evenements.js/naf.js.
//
// Sources (données statiques embarquées à la construction — aucune requête
// réseau au chargement) :
//  - IFN : « Superficie de forêt par essence » (Ecolab, data.gouv
//    6a471c45e8b3be060f779d2f, licence ouverte), millésime 2024 — hectares par
//    essence et par département (90 départements ; pas de bouleau/aulne, noyés
//    dans « Autres feuillus » — piège n°38). Indicateur = part de la
//    superficie du département (ha/km²).
//  - Chorologie indicative : GBIF (api.gbif.org) — occurrences agrégées par
//    département GADM (facette gadmGid niveau 2, taxonKey par espèce/genre,
//    dénominateur d'effort = occurrences Plantae du département), collecte
//    10/2026. INDICATIF : biais d'échantillonnage (inventaires, données
//    participatives, effectifs urbains) — piège n°37. Licences des
//    fournisseurs GBIF (majoritairement CC-BY/CC0).
//  - Graminées cultivées (proxy) : Agreste RGA 2020 « SAU par type de culture
//    et par EPCI » (TACCT 96fa7529-f87a-4a3e-b5e8-2e84286fb6dc), agrégé EPCI →
//    département via BANATIC (natures juridiques CC/CA/CU/METRO/MET69/SMF),
//    licence ouverte — piège n°39.
//  - Notation allergénique 0–5 et calendriers de pollinisation : RNSA
//    (pollens.fr) et rapport ANSES 2019 « Qualité de l'air ambiant — pollens »
//    (référentiel statique curé, aucune copie de données volumineuses).
//
// Méthode : exposition relative 1–5 par QUINTILES (5 = les 20 % de départements
// les plus exposés) — pour la superficie (IFN/Agreste) : % de la superficie du
// département ; pour la chorologie (GBIF) : part des occurrences de l'essence
// parmi les occurrences de plantes du département (dénominateur d'effort).
// Les valeurs 0 de l'IFN sont des surfaces réellement nulles (≠ absence de
// données) : elles participent à l'échelle en tant qu'exposition « très faible ».

var PLE = {
  active: false,     // vue structurelle affichée
  layer: null,       // couche choroplèthe départements (Leaflet)
  ind: null,         // indicateur courant (PLE_ES)
  vals: {},          // valeurs calculées { code: { m, disp, ix, lines } }
  view: 'jour',      // 'jour' | 'ess'
  prevRefresh: null  // refresh() de pollens.js avant le remplacement
};

var PLE_COLORS = ['#22c55e', '#a3e635', '#eab308', '#fb923c', '#ef4444'];
var PLE_IX_LABELS = ['Très faible', 'Faible', 'Modérée', 'Élevée', 'Très élevée'];
var PLE_GREY = '#475569';
var PLE_MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

var PLE_GR_LIB = {
  ifn: 'superficie forestière IFN 2024',
  choro: 'chorologie indicative GBIF',
  agri: 'proxy cultures Agreste RGA 2020'
};

// Indicateurs du sélecteur « Exposition ». `taxon` = taxon suivi par l'indice
// quotidien (pollens.js) lorsque l'essence en fait partie.
var PLE_ES = [
  // --- Forêts : superficie par essence (IFN 2024) ---
  { id: 'chenes', groupe: 'ifn', label: 'Chênes', latin: 'Quercus',
    champs: ['sessile', 'pedoncule', 'pubescent', 'vert'], notation: 2, cal: [4, 6],
    note: 'fortes concentrations printanières mais faible allergénicité ; le chêne vert est surtout méditerranéen' },
  { id: 'hetre', groupe: 'ifn', label: 'Hêtre', latin: 'Fagus sylvatica',
    champs: ['hetre'], notation: 1, cal: [4, 6],
    note: 'pollen peu volatil en plaine, rarement allergisant (essence de montagne)' },
  { id: 'charme', groupe: 'ifn', label: 'Charme', latin: 'Carpinus betulus',
    champs: ['charme'], notation: 2, cal: [4, 5],
    note: 'pollen abondant mais saison courte ; croisement possible avec le bouleau' },
  { id: 'chataignier', groupe: 'ifn', label: 'Châtaignier', latin: 'Castanea sativa',
    champs: ['chataignier'], notation: 1, cal: [6, 7],
    note: 'pollinisation estivale, faible allergénicité' },
  { id: 'frene', groupe: 'ifn', label: 'Frêne', latin: 'Fraxinus excelsior',
    champs: ['frene'], notation: 3, cal: [3, 5],
    note: 'pollinisation précoce, croisements oléacées (olivier/lilas)' },
  { id: 'pins', groupe: 'ifn', label: 'Pins', latin: 'Pinus',
    champs: ['pin_maritime', 'pin_sylvestre'], notation: 1, cal: [4, 6],
    note: 'pollen très abondant mais peu allergisant (landes de Gascogne, pins sylvestres)' },
  { id: 'conif_alt', groupe: 'ifn', label: 'Sapins, épicéas & douglas', latin: 'Abies / Picea / Pseudotsuga',
    champs: ['sapin', 'epicea', 'douglas'], notation: 1, cal: [5, 6],
    note: 'conifères de montagne, pollen peu allergisant' },
  // --- Chorologie indicative (occurrences GBIF agrégées par département, 10/2026) ---
  { id: 'betula', groupe: 'choro', label: 'Bouleau', latin: 'Betula',
    notation: 5, cal: [3, 5], taxon: 'bouleau',
    note: 'un des principaux allergènes arboricoles du nord et de l\'est' },
  { id: 'alnus', groupe: 'choro', label: 'Aulne', latin: 'Alnus',
    notation: 3, cal: [1, 3], taxon: 'aulne',
    note: 'ripisylves et zones humides ; pollinise fin hiver, croisement fréquent avec le bouleau' },
  { id: 'corylus', groupe: 'choro', label: 'Noisetier', latin: 'Corylus',
    notation: 3, cal: [1, 3],
    note: 'sous-bois et haies ; réaction croisée fréquente avec le bouleau' },
  { id: 'platanus', groupe: 'choro', label: 'Platane', latin: 'Platanus',
    notation: 2, cal: [3, 5],
    note: 'alignements urbains du Midi ; les poils des fruits sont plus irritants que le pollen' },
  { id: 'populus', groupe: 'choro', label: 'Peuplier', latin: 'Populus',
    notation: 2, cal: [2, 4],
    note: 'peupleraies et ripisylves ; pollinisation précoce' },
  { id: 'cedrus', groupe: 'choro', label: 'Cèdre de l\'Atlas', latin: 'Cedrus atlantica',
    notation: 3, cal: [10, 12],
    note: 'reboisements méditerranéens ; pollinisation automnale' },
  { id: 'cupressus', groupe: 'choro', label: 'Cyprès', latin: 'Cupressus sempervirens',
    notation: 5, cal: [1, 4],
    note: 'allergène majeur du pourtour méditerranéen (pollinisation hivernale) — non suivi par l\'indice national' },
  { id: 'olea', groupe: 'choro', label: 'Olivier', latin: 'Olea europaea',
    notation: 3, cal: [5, 7], taxon: 'olivier',
    note: 'vergers du pourtour méditerranéen' },
  { id: 'ambrosia', groupe: 'choro', label: 'Ambroisie', latin: 'Ambrosia artemisiifolia',
    notation: 5, cal: [8, 10], taxon: 'ambroisie',
    note: 'allergène majeur, saison estivale (ANSES : enjeu sanitaire) — surtout le couloir Rhône-Saône' },
  { id: 'artemisia', groupe: 'choro', label: 'Armoise', latin: 'Artemisia vulgaris',
    notation: 3, cal: [7, 9], taxon: 'armoise',
    note: 'friches et bords de route, fin d\'été' },
  // --- Graminées cultivées : proxy Agreste RGA 2020 ---
  { id: 'cer', groupe: 'agri', label: 'Graminées — céréales', latin: 'Poaceae (cultivées)',
    champ: 'cer', notation: 4, cal: [5, 7], taxon: 'graminees',
    note: 'proxy : superficie en céréales (blé, orge, maïs…) ; émissions surtout de mai à juillet' },
  { id: 'herbe', groupe: 'agri', label: 'Graminées — prairies & herbages', latin: 'Poaceae (prairies)',
    champ: 'herbe', notation: 5, cal: [5, 9], taxon: 'graminees',
    note: 'proxy : prairies et herbages permanents — première source de pollen de graminées' }
];

var PLE_DEP_AREA = 
{"10":6010,"11":6342,"12":8764,"13":5236,"14":5569,"15":5759,"16":5962,"17":6892,"18":7275,"19":5879,"21":8776,"22":6961,"23":5586,"24":9203,"25":5241,"26":6671,"27":6026,"28":5918,"29":6768,"30":5871,"31":6331,"32":6287,"33":10077,"34":6223,"35":6825,"36":6900,"37":6147,"38":7867,"39":5034,"40":9342,"41":6411,"42":4792,"43":4992,"44":6992,"45":6789,"46":5220,"47":5351,"48":5173,"49":7149,"50":6019,"51":8171,"52":6244,"53":5197,"54":5269,"55":6219,"56":6840,"57":6226,"58":6854,"59":5739,"60":5884,"61":6132,"62":6691,"63":8001,"64":7714,"65":4506,"66":4140,"67":4786,"68":3524,"69":3253,"70":5374,"71":8590,"72":6216,"73":6260,"74":4594,"75":104,"76":6282,"77":5909,"78":2300,"79":6038,"80":6163,"81":5768,"82":3730,"83":6011,"84":3569,"85":6741,"86":7009,"87":5545,"88":5875,"89":7439,"90":607,"91":1808,"92":175,"93":235,"94":247,"95":1250,"01":5765,"02":7390,"03":7358,"04":6988,"05":5669,"06":4276,"07":5549,"08":5226,"09":4906,"2A":3995,"2B":4700}
;
var PLE_IFN = 
{"10":{"autres_conif":3000,"autres_feuil":25000,"charme":17000,"chataignier":0,"pubescent":0,"pedoncule":27000,"sessile":48000,"vert":0,"douglas":3000,"frene":5000,"hetre":12000,"pin_maritime":0,"pin_sylvestre":10000,"sapin":1000,"epicea":1000},"11":{"autres_conif":62000,"autres_feuil":8000,"charme":0,"chataignier":4000,"pubescent":44000,"pedoncule":2000,"sessile":3000,"vert":65000,"douglas":4000,"frene":12000,"hetre":28000,"pin_maritime":3000,"pin_sylvestre":8000,"sapin":15000,"epicea":4000},"12":{"autres_conif":13000,"autres_feuil":11000,"charme":1000,"chataignier":35000,"pubescent":94000,"pedoncule":33000,"sessile":21000,"vert":0,"douglas":9000,"frene":17000,"hetre":25000,"pin_maritime":0,"pin_sylvestre":28000,"sapin":3000,"epicea":1000},"13":{"autres_conif":86000,"autres_feuil":7000,"charme":0,"chataignier":0,"pubescent":11000,"pedoncule":0,"sessile":0,"vert":31000,"douglas":0,"frene":5000,"hetre":0,"pin_maritime":1000,"pin_sylvestre":0,"sapin":0,"epicea":0},"14":{"autres_conif":3000,"autres_feuil":18000,"charme":1000,"chataignier":1000,"pubescent":0,"pedoncule":10000,"sessile":9000,"vert":0,"douglas":4000,"frene":9000,"hetre":7000,"pin_maritime":0,"pin_sylvestre":2000,"sapin":1000,"epicea":1000},"15":{"autres_conif":2000,"autres_feuil":12000,"charme":1000,"chataignier":5000,"pubescent":1000,"pedoncule":29000,"sessile":22000,"vert":0,"douglas":9000,"frene":11000,"hetre":39000,"pin_maritime":0,"pin_sylvestre":10000,"sapin":9000,"epicea":5000},"16":{"autres_conif":5000,"autres_feuil":16000,"charme":5000,"chataignier":23000,"pubescent":31000,"pedoncule":32000,"sessile":10000,"vert":0,"douglas":1000,"frene":6000,"hetre":0,"pin_maritime":7000,"pin_sylvestre":0,"sapin":0,"epicea":0},"17":{"autres_conif":2000,"autres_feuil":17000,"charme":3000,"chataignier":8000,"pubescent":20000,"pedoncule":32000,"sessile":1000,"vert":2000,"douglas":0,"frene":10000,"hetre":1000,"pin_maritime":24000,"pin_sylvestre":0,"sapin":1000,"epicea":0},"18":{"autres_conif":8000,"autres_feuil":30000,"charme":18000,"chataignier":5000,"pubescent":7000,"pedoncule":52000,"sessile":49000,"vert":0,"douglas":1000,"frene":4000,"hetre":1000,"pin_maritime":2000,"pin_sylvestre":19000,"sapin":0,"epicea":0},"19":{"autres_conif":9000,"autres_feuil":39000,"charme":11000,"chataignier":29000,"pubescent":7000,"pedoncule":64000,"sessile":7000,"vert":0,"douglas":37000,"frene":2000,"hetre":34000,"pin_maritime":1000,"pin_sylvestre":17000,"sapin":4000,"epicea":10000},"21":{"autres_conif":11000,"autres_feuil":37000,"charme":38000,"chataignier":0,"pubescent":4000,"pedoncule":56000,"sessile":104000,"vert":0,"douglas":11000,"frene":9000,"hetre":55000,"pin_maritime":0,"pin_sylvestre":5000,"sapin":2000,"epicea":1000},"22":{"autres_conif":7000,"autres_feuil":27000,"charme":0,"chataignier":7000,"pubescent":0,"pedoncule":35000,"sessile":5000,"vert":0,"douglas":4000,"frene":3000,"hetre":10000,"pin_maritime":1000,"pin_sylvestre":3000,"sapin":1000,"epicea":0},"23":{"autres_conif":3000,"autres_feuil":27000,"charme":2000,"chataignier":17000,"pubescent":0,"pedoncule":52000,"sessile":6000,"vert":0,"douglas":24000,"frene":1000,"hetre":15000,"pin_maritime":0,"pin_sylvestre":5000,"sapin":3000,"epicea":8000},"24":{"autres_conif":11000,"autres_feuil":52000,"charme":21000,"chataignier":75000,"pubescent":92000,"pedoncule":91000,"sessile":16000,"vert":1000,"douglas":2000,"frene":5000,"hetre":1000,"pin_maritime":44000,"pin_sylvestre":9000,"sapin":0,"epicea":0},"25":{"autres_conif":1000,"autres_feuil":19000,"charme":17000,"chataignier":0,"pubescent":1000,"pedoncule":15000,"sessile":26000,"vert":0,"douglas":1000,"frene":5000,"hetre":51000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":50000,"epicea":39000},"26":{"autres_conif":45000,"autres_feuil":25000,"charme":0,"chataignier":4000,"pubescent":93000,"pedoncule":0,"sessile":6000,"vert":11000,"douglas":1000,"frene":3000,"hetre":41000,"pin_maritime":1000,"pin_sylvestre":79000,"sapin":8000,"epicea":6000},"27":{"autres_conif":6000,"autres_feuil":20000,"charme":7000,"chataignier":2000,"pubescent":0,"pedoncule":16000,"sessile":50000,"vert":0,"douglas":5000,"frene":5000,"hetre":11000,"pin_maritime":1000,"pin_sylvestre":5000,"sapin":0,"epicea":1000},"28":{"autres_conif":0,"autres_feuil":14000,"charme":4000,"chataignier":1000,"pubescent":0,"pedoncule":17000,"sessile":44000,"vert":0,"douglas":1000,"frene":3000,"hetre":1000,"pin_maritime":0,"pin_sylvestre":0,"sapin":0,"epicea":0},"29":{"autres_conif":8000,"autres_feuil":31000,"charme":0,"chataignier":6000,"pubescent":0,"pedoncule":41000,"sessile":4000,"vert":0,"douglas":4000,"frene":1000,"hetre":5000,"pin_maritime":4000,"pin_sylvestre":1000,"sapin":1000,"epicea":0},"30":{"autres_conif":31000,"autres_feuil":10000,"charme":0,"chataignier":21000,"pubescent":53000,"pedoncule":0,"sessile":1000,"vert":126000,"douglas":0,"frene":3000,"hetre":8000,"pin_maritime":16000,"pin_sylvestre":3000,"sapin":2000,"epicea":3000},"31":{"autres_conif":3000,"autres_feuil":13000,"charme":0,"chataignier":10000,"pubescent":35000,"pedoncule":18000,"sessile":7000,"vert":0,"douglas":2000,"frene":14000,"hetre":20000,"pin_maritime":1000,"pin_sylvestre":0,"sapin":10000,"epicea":1000},"32":{"autres_conif":2000,"autres_feuil":13000,"charme":7000,"chataignier":4000,"pubescent":30000,"pedoncule":31000,"sessile":4000,"vert":0,"douglas":0,"frene":4000,"hetre":1000,"pin_maritime":1000,"pin_sylvestre":1000,"sapin":0,"epicea":0},"33":{"autres_conif":5000,"autres_feuil":60000,"charme":11000,"chataignier":5000,"pubescent":8000,"pedoncule":107000,"sessile":1000,"vert":1000,"douglas":0,"frene":8000,"hetre":0,"pin_maritime":279000,"pin_sylvestre":0,"sapin":0,"epicea":0},"34":{"autres_conif":47000,"autres_feuil":17000,"charme":0,"chataignier":9000,"pubescent":51000,"pedoncule":0,"sessile":3000,"vert":116000,"douglas":4000,"frene":8000,"hetre":13000,"pin_maritime":1000,"pin_sylvestre":3000,"sapin":1000,"epicea":2000},"35":{"autres_conif":4000,"autres_feuil":14000,"charme":1000,"chataignier":7000,"pubescent":0,"pedoncule":22000,"sessile":13000,"vert":0,"douglas":5000,"frene":0,"hetre":3000,"pin_maritime":7000,"pin_sylvestre":6000,"sapin":1000,"epicea":0},"36":{"autres_conif":5000,"autres_feuil":13000,"charme":7000,"chataignier":5000,"pubescent":4000,"pedoncule":58000,"sessile":41000,"vert":0,"douglas":1000,"frene":3000,"hetre":0,"pin_maritime":1000,"pin_sylvestre":1000,"sapin":0,"epicea":0},"37":{"autres_conif":5000,"autres_feuil":22000,"charme":6000,"chataignier":11000,"pubescent":9000,"pedoncule":36000,"sessile":39000,"vert":0,"douglas":0,"frene":3000,"hetre":1000,"pin_maritime":28000,"pin_sylvestre":4000,"sapin":1000,"epicea":0},"38":{"autres_conif":6000,"autres_feuil":49000,"charme":5000,"chataignier":24000,"pubescent":7000,"pedoncule":7000,"sessile":30000,"vert":0,"douglas":0,"frene":25000,"hetre":37000,"pin_maritime":0,"pin_sylvestre":15000,"sapin":35000,"epicea":29000},"39":{"autres_conif":3000,"autres_feuil":33000,"charme":23000,"chataignier":1000,"pubescent":1000,"pedoncule":15000,"sessile":39000,"vert":0,"douglas":3000,"frene":13000,"hetre":44000,"pin_maritime":0,"pin_sylvestre":4000,"sapin":39000,"epicea":18000},"40":{"autres_conif":6000,"autres_feuil":62000,"charme":0,"chataignier":2000,"pubescent":0,"pedoncule":74000,"sessile":0,"vert":0,"douglas":0,"frene":3000,"hetre":2000,"pin_maritime":405000,"pin_sylvestre":0,"sapin":0,"epicea":0},"41":{"autres_conif":10000,"autres_feuil":35000,"charme":5000,"chataignier":6000,"pubescent":2000,"pedoncule":90000,"sessile":52000,"vert":0,"douglas":2000,"frene":3000,"hetre":0,"pin_maritime":7000,"pin_sylvestre":30000,"sapin":0,"epicea":0},"42":{"autres_conif":1000,"autres_feuil":22000,"charme":2000,"chataignier":4000,"pubescent":2000,"pedoncule":12000,"sessile":21000,"vert":0,"douglas":24000,"frene":10000,"hetre":6000,"pin_maritime":0,"pin_sylvestre":10000,"sapin":23000,"epicea":7000},"43":{"autres_conif":1000,"autres_feuil":9000,"charme":0,"chataignier":1000,"pubescent":8000,"pedoncule":6000,"sessile":18000,"vert":0,"douglas":16000,"frene":8000,"hetre":23000,"pin_maritime":0,"pin_sylvestre":43000,"sapin":44000,"epicea":17000},"44":{"autres_conif":3000,"autres_feuil":12000,"charme":0,"chataignier":6000,"pubescent":0,"pedoncule":30000,"sessile":12000,"vert":1000,"douglas":1000,"frene":3000,"hetre":1000,"pin_maritime":4000,"pin_sylvestre":2000,"sapin":0,"epicea":0},"45":{"autres_conif":12000,"autres_feuil":37000,"charme":5000,"chataignier":3000,"pubescent":2000,"pedoncule":77000,"sessile":49000,"vert":0,"douglas":0,"frene":3000,"hetre":0,"pin_maritime":1000,"pin_sylvestre":16000,"sapin":0,"epicea":0},"46":{"autres_conif":4000,"autres_feuil":14000,"charme":4000,"chataignier":18000,"pubescent":175000,"pedoncule":17000,"sessile":2000,"vert":0,"douglas":2000,"frene":3000,"hetre":3000,"pin_maritime":4000,"pin_sylvestre":0,"sapin":0,"epicea":0},"47":{"autres_conif":4000,"autres_feuil":22000,"charme":3000,"chataignier":3000,"pubescent":28000,"pedoncule":37000,"sessile":2000,"vert":0,"douglas":0,"frene":3000,"hetre":0,"pin_maritime":36000,"pin_sylvestre":0,"sapin":0,"epicea":0},"48":{"autres_conif":29000,"autres_feuil":19000,"charme":0,"chataignier":13000,"pubescent":7000,"pedoncule":0,"sessile":6000,"vert":5000,"douglas":7000,"frene":4000,"hetre":40000,"pin_maritime":6000,"pin_sylvestre":83000,"sapin":7000,"epicea":19000},"49":{"autres_conif":5000,"autres_feuil":21000,"charme":0,"chataignier":10000,"pubescent":2000,"pedoncule":32000,"sessile":8000,"vert":0,"douglas":2000,"frene":5000,"hetre":0,"pin_maritime":16000,"pin_sylvestre":2000,"sapin":0,"epicea":0},"50":{"autres_conif":1000,"autres_feuil":9000,"charme":0,"chataignier":2000,"pubescent":0,"pedoncule":8000,"sessile":5000,"vert":0,"douglas":1000,"frene":2000,"hetre":7000,"pin_maritime":2000,"pin_sylvestre":1000,"sapin":0,"epicea":0},"51":{"autres_conif":6000,"autres_feuil":54000,"charme":17000,"chataignier":2000,"pubescent":0,"pedoncule":26000,"sessile":29000,"vert":0,"douglas":2000,"frene":18000,"hetre":8000,"pin_maritime":0,"pin_sylvestre":14000,"sapin":0,"epicea":2000},"52":{"autres_conif":4000,"autres_feuil":27000,"charme":53000,"chataignier":1000,"pubescent":0,"pedoncule":37000,"sessile":41000,"vert":0,"douglas":6000,"frene":11000,"hetre":56000,"pin_maritime":0,"pin_sylvestre":6000,"sapin":4000,"epicea":5000},"53":{"autres_conif":1000,"autres_feuil":10000,"charme":0,"chataignier":6000,"pubescent":0,"pedoncule":8000,"sessile":16000,"vert":0,"douglas":5000,"frene":2000,"hetre":1000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":0,"epicea":0},"54":{"autres_conif":1000,"autres_feuil":27000,"charme":31000,"chataignier":0,"pubescent":0,"pedoncule":22000,"sessile":33000,"vert":0,"douglas":2000,"frene":6000,"hetre":36000,"pin_maritime":0,"pin_sylvestre":3000,"sapin":10000,"epicea":3000},"55":{"autres_conif":3000,"autres_feuil":29000,"charme":48000,"chataignier":0,"pubescent":0,"pedoncule":36000,"sessile":22000,"vert":0,"douglas":4000,"frene":5000,"hetre":73000,"pin_maritime":0,"pin_sylvestre":2000,"sapin":0,"epicea":3000},"56":{"autres_conif":1000,"autres_feuil":26000,"charme":1000,"chataignier":22000,"pubescent":0,"pedoncule":52000,"sessile":8000,"vert":0,"douglas":6000,"frene":1000,"hetre":5000,"pin_maritime":18000,"pin_sylvestre":4000,"sapin":0,"epicea":0},"57":{"autres_conif":2000,"autres_feuil":35000,"charme":14000,"chataignier":0,"pubescent":0,"pedoncule":20000,"sessile":43000,"vert":0,"douglas":3000,"frene":7000,"hetre":45000,"pin_maritime":0,"pin_sylvestre":13000,"sapin":7000,"epicea":9000},"58":{"autres_conif":3000,"autres_feuil":27000,"charme":23000,"chataignier":2000,"pubescent":1000,"pedoncule":43000,"sessile":97000,"vert":0,"douglas":24000,"frene":2000,"hetre":12000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":5000,"epicea":5000},"59":{"autres_conif":1000,"autres_feuil":25000,"charme":5000,"chataignier":1000,"pubescent":0,"pedoncule":18000,"sessile":4000,"vert":0,"douglas":0,"frene":1000,"hetre":2000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":0,"epicea":2000},"60":{"autres_conif":1000,"autres_feuil":26000,"charme":10000,"chataignier":9000,"pubescent":0,"pedoncule":18000,"sessile":23000,"vert":0,"douglas":3000,"frene":11000,"hetre":19000,"pin_maritime":0,"pin_sylvestre":3000,"sapin":0,"epicea":1000},"61":{"autres_conif":7000,"autres_feuil":19000,"charme":1000,"chataignier":4000,"pubescent":0,"pedoncule":13000,"sessile":33000,"vert":0,"douglas":8000,"frene":5000,"hetre":8000,"pin_maritime":0,"pin_sylvestre":4000,"sapin":2000,"epicea":1000},"62":{"autres_conif":2000,"autres_feuil":40000,"charme":2000,"chataignier":1000,"pubescent":0,"pedoncule":5000,"sessile":2000,"vert":0,"douglas":0,"frene":2000,"hetre":11000,"pin_maritime":1000,"pin_sylvestre":0,"sapin":0,"epicea":0},"63":{"autres_conif":2000,"autres_feuil":32000,"charme":2000,"chataignier":1000,"pubescent":6000,"pedoncule":37000,"sessile":27000,"vert":0,"douglas":28000,"frene":21000,"hetre":29000,"pin_maritime":0,"pin_sylvestre":16000,"sapin":40000,"epicea":30000},"64":{"autres_conif":3000,"autres_feuil":43000,"charme":1000,"chataignier":15000,"pubescent":3000,"pedoncule":83000,"sessile":1000,"vert":0,"douglas":1000,"frene":11000,"hetre":46000,"pin_maritime":1000,"pin_sylvestre":0,"sapin":1000,"epicea":1000},"65":{"autres_conif":6000,"autres_feuil":20000,"charme":0,"chataignier":9000,"pubescent":7000,"pedoncule":20000,"sessile":4000,"vert":0,"douglas":3000,"frene":14000,"hetre":32000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":13000,"epicea":2000},"66":{"autres_conif":39000,"autres_feuil":20000,"charme":0,"chataignier":9000,"pubescent":24000,"pedoncule":0,"sessile":2000,"vert":62000,"douglas":0,"frene":9000,"hetre":10000,"pin_maritime":0,"pin_sylvestre":10000,"sapin":4000,"epicea":1000},"67":{"autres_conif":1000,"autres_feuil":37000,"charme":7000,"chataignier":4000,"pubescent":0,"pedoncule":11000,"sessile":25000,"vert":0,"douglas":8000,"frene":7000,"hetre":36000,"pin_maritime":0,"pin_sylvestre":22000,"sapin":13000,"epicea":16000},"68":{"autres_conif":1000,"autres_feuil":24000,"charme":8000,"chataignier":2000,"pubescent":1000,"pedoncule":5000,"sessile":20000,"vert":0,"douglas":3000,"frene":5000,"hetre":33000,"pin_maritime":0,"pin_sylvestre":6000,"sapin":20000,"epicea":12000},"69":{"autres_conif":3000,"autres_feuil":11000,"charme":1000,"chataignier":8000,"pubescent":3000,"pedoncule":2000,"sessile":23000,"vert":0,"douglas":18000,"frene":11000,"hetre":1000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":6000,"epicea":0},"70":{"autres_conif":2000,"autres_feuil":39000,"charme":26000,"chataignier":1000,"pubescent":0,"pedoncule":30000,"sessile":69000,"vert":0,"douglas":6000,"frene":4000,"hetre":36000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":10000,"epicea":5000},"71":{"autres_conif":1000,"autres_feuil":38000,"charme":17000,"chataignier":5000,"pubescent":2000,"pedoncule":41000,"sessile":53000,"vert":0,"douglas":31000,"frene":6000,"hetre":6000,"pin_maritime":0,"pin_sylvestre":0,"sapin":3000,"epicea":1000},"72":{"autres_conif":6000,"autres_feuil":21000,"charme":3000,"chataignier":11000,"pubescent":0,"pedoncule":23000,"sessile":32000,"vert":0,"douglas":1000,"frene":3000,"hetre":1000,"pin_maritime":23000,"pin_sylvestre":3000,"sapin":1000,"epicea":0},"73":{"autres_conif":11000,"autres_feuil":28000,"charme":3000,"chataignier":5000,"pubescent":3000,"pedoncule":1000,"sessile":10000,"vert":0,"douglas":1000,"frene":15000,"hetre":31000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":14000,"epicea":54000},"74":{"autres_conif":0,"autres_feuil":12000,"charme":2000,"chataignier":3000,"pubescent":0,"pedoncule":4000,"sessile":11000,"vert":0,"douglas":1000,"frene":9000,"hetre":40000,"pin_maritime":0,"pin_sylvestre":0,"sapin":12000,"epicea":51000},"75":{"autres_conif":2000,"autres_feuil":31000,"charme":5000,"chataignier":19000,"pubescent":4000,"pedoncule":24000,"sessile":33000,"vert":0,"douglas":0,"frene":7000,"hetre":2000,"pin_maritime":1000,"pin_sylvestre":6000,"sapin":0,"epicea":0},"76":{"autres_conif":3000,"autres_feuil":20000,"charme":5000,"chataignier":4000,"pubescent":0,"pedoncule":11000,"sessile":12000,"vert":0,"douglas":2000,"frene":2000,"hetre":37000,"pin_maritime":0,"pin_sylvestre":5000,"sapin":0,"epicea":2000},"77":{"autres_conif":0,"autres_feuil":34000,"charme":5000,"chataignier":4000,"pubescent":5000,"pedoncule":31000,"sessile":35000,"vert":0,"douglas":1000,"frene":10000,"hetre":3000,"pin_maritime":2000,"pin_sylvestre":8000,"sapin":0,"epicea":0},"79":{"autres_conif":2000,"autres_feuil":8000,"charme":1000,"chataignier":6000,"pubescent":9000,"pedoncule":14000,"sessile":6000,"vert":0,"douglas":1000,"frene":6000,"hetre":1000,"pin_maritime":1000,"pin_sylvestre":0,"sapin":0,"epicea":1000},"80":{"autres_conif":3000,"autres_feuil":22000,"charme":9000,"chataignier":0,"pubescent":0,"pedoncule":9000,"sessile":2000,"vert":0,"douglas":0,"frene":6000,"hetre":15000,"pin_maritime":0,"pin_sylvestre":2000,"sapin":0,"epicea":1000},"81":{"autres_conif":9000,"autres_feuil":10000,"charme":1000,"chataignier":16000,"pubescent":38000,"pedoncule":21000,"sessile":33000,"vert":0,"douglas":14000,"frene":10000,"hetre":17000,"pin_maritime":1000,"pin_sylvestre":4000,"sapin":5000,"epicea":10000},"82":{"autres_conif":2000,"autres_feuil":11000,"charme":2000,"chataignier":4000,"pubescent":48000,"pedoncule":11000,"sessile":1000,"vert":0,"douglas":0,"frene":2000,"hetre":0,"pin_maritime":1000,"pin_sylvestre":0,"sapin":0,"epicea":0},"83":{"autres_conif":72000,"autres_feuil":70000,"charme":0,"chataignier":0,"pubescent":93000,"pedoncule":0,"sessile":0,"vert":94000,"douglas":0,"frene":3000,"hetre":1000,"pin_maritime":24000,"pin_sylvestre":19000,"sapin":1000,"epicea":0},"84":{"autres_conif":49000,"autres_feuil":10000,"charme":0,"chataignier":0,"pubescent":35000,"pedoncule":0,"sessile":0,"vert":37000,"douglas":0,"frene":1000,"hetre":6000,"pin_maritime":4000,"pin_sylvestre":5000,"sapin":0,"epicea":0},"85":{"autres_conif":1000,"autres_feuil":6000,"charme":1000,"chataignier":4000,"pubescent":1000,"pedoncule":17000,"sessile":8000,"vert":3000,"douglas":0,"frene":3000,"hetre":0,"pin_maritime":5000,"pin_sylvestre":1000,"sapin":0,"epicea":0},"86":{"autres_conif":4000,"autres_feuil":20000,"charme":3000,"chataignier":6000,"pubescent":24000,"pedoncule":45000,"sessile":15000,"vert":0,"douglas":0,"frene":2000,"hetre":1000,"pin_maritime":8000,"pin_sylvestre":2000,"sapin":0,"epicea":0},"87":{"autres_conif":2000,"autres_feuil":21000,"charme":3000,"chataignier":34000,"pubescent":0,"pedoncule":57000,"sessile":4000,"vert":0,"douglas":22000,"frene":3000,"hetre":7000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":2000,"epicea":1000},"88":{"autres_conif":1000,"autres_feuil":37000,"charme":15000,"chataignier":1000,"pubescent":0,"pedoncule":22000,"sessile":35000,"vert":0,"douglas":7000,"frene":3000,"hetre":62000,"pin_maritime":0,"pin_sylvestre":9000,"sapin":63000,"epicea":39000},"89":{"autres_conif":9000,"autres_feuil":28000,"charme":31000,"chataignier":2000,"pubescent":0,"pedoncule":43000,"sessile":105000,"vert":0,"douglas":9000,"frene":6000,"hetre":10000,"pin_maritime":0,"pin_sylvestre":6000,"sapin":1000,"epicea":0},"90":{"autres_conif":0,"autres_feuil":3000,"charme":5000,"chataignier":0,"pubescent":0,"pedoncule":4000,"sessile":6000,"vert":0,"douglas":0,"frene":0,"hetre":7000,"pin_maritime":0,"pin_sylvestre":0,"sapin":2000,"epicea":1000},"01":{"autres_conif":4000,"autres_feuil":41000,"charme":7000,"chataignier":2000,"pubescent":10000,"pedoncule":16000,"sessile":34000,"vert":0,"douglas":1000,"frene":9000,"hetre":36000,"pin_maritime":0,"pin_sylvestre":2000,"sapin":21000,"epicea":14000},"02":{"autres_conif":0,"autres_feuil":62000,"charme":15000,"chataignier":5000,"pubescent":0,"pedoncule":21000,"sessile":14000,"vert":0,"douglas":1000,"frene":20000,"hetre":18000,"pin_maritime":0,"pin_sylvestre":1000,"sapin":0,"epicea":2000},"03":{"autres_conif":2000,"autres_feuil":13000,"charme":10000,"chataignier":1000,"pubescent":0,"pedoncule":39000,"sessile":44000,"vert":0,"douglas":10000,"frene":7000,"hetre":5000,"pin_maritime":0,"pin_sylvestre":4000,"sapin":1000,"epicea":1000},"04":{"autres_conif":76000,"autres_feuil":19000,"charme":0,"chataignier":0,"pubescent":104000,"pedoncule":0,"sessile":0,"vert":20000,"douglas":0,"frene":4000,"hetre":34000,"pin_maritime":0,"pin_sylvestre":121000,"sapin":3000,"epicea":6000},"05":{"autres_conif":84000,"autres_feuil":12000,"charme":0,"chataignier":0,"pubescent":19000,"pedoncule":0,"sessile":0,"vert":0,"douglas":0,"frene":3000,"hetre":23000,"pin_maritime":0,"pin_sylvestre":63000,"sapin":8000,"epicea":0},"06":{"autres_conif":43000,"autres_feuil":25000,"charme":0,"chataignier":0,"pubescent":50000,"pedoncule":0,"sessile":0,"vert":12000,"douglas":0,"frene":2000,"hetre":2000,"pin_maritime":5000,"pin_sylvestre":63000,"sapin":12000,"epicea":2000},"07":{"autres_conif":17000,"autres_feuil":17000,"charme":0,"chataignier":41000,"pubescent":74000,"pedoncule":0,"sessile":8000,"vert":45000,"douglas":12000,"frene":24000,"hetre":22000,"pin_maritime":11000,"pin_sylvestre":30000,"sapin":21000,"epicea":12000},"08":{"autres_conif":3000,"autres_feuil":35000,"charme":13000,"chataignier":1000,"pubescent":0,"pedoncule":14000,"sessile":42000,"vert":0,"douglas":4000,"frene":12000,"hetre":13000,"pin_maritime":0,"pin_sylvestre":2000,"sapin":0,"epicea":20000},"09":{"autres_conif":7000,"autres_feuil":25000,"charme":0,"chataignier":8000,"pubescent":32000,"pedoncule":24000,"sessile":6000,"vert":0,"douglas":3000,"frene":24000,"hetre":57000,"pin_maritime":0,"pin_sylvestre":4000,"sapin":15000,"epicea":1000},"2A":{"autres_conif":16000,"autres_feuil":62000,"charme":0,"chataignier":4000,"pubescent":3000,"pedoncule":0,"sessile":0,"vert":120000,"douglas":0,"frene":1000,"hetre":8000,"pin_maritime":18000,"pin_sylvestre":0,"sapin":0,"epicea":0},"2B":{"autres_conif":28000,"autres_feuil":82000,"charme":0,"chataignier":21000,"pubescent":13000,"pedoncule":0,"sessile":0,"vert":62000,"douglas":0,"frene":1000,"hetre":5000,"pin_maritime":12000,"pin_sylvestre":0,"sapin":0,"epicea":0}}
;
var PLE_AGRI = 
{"10":{"cer":204939,"herbe":25107},"11":{"cer":39832,"herbe":50180},"12":{"cer":62672,"herbe":289313},"13":{"cer":25591,"herbe":65662},"14":{"cer":113931,"herbe":152879},"15":{"cer":10227,"herbe":289697},"16":{"cer":117991,"herbe":63554},"17":{"cer":187739,"herbe":58247},"18":{"cer":203326,"herbe":98510},"19":{"cer":11891,"herbe":190707},"21":{"cer":191881,"herbe":140439},"22":{"cer":159457,"herbe":76516},"23":{"cer":36368,"herbe":198307},"24":{"cer":64995,"herbe":129583},"25":{"cer":17776,"herbe":166629},"26":{"cer":50458,"herbe":51298},"27":{"cer":182685,"herbe":47333},"28":{"cer":282757,"herbe":14790},"29":{"cer":129514,"herbe":90822},"30":{"cer":17013,"herbe":41913},"31":{"cer":127034,"herbe":65106},"32":{"cer":165735,"herbe":54858},"33":{"cer":33295,"herbe":45516},"34":{"cer":13610,"herbe":49716},"35":{"cer":149944,"herbe":97137},"36":{"cer":180935,"herbe":121383},"37":{"cer":158377,"herbe":35755},"38":{"cer":73017,"herbe":107504},"39":{"cer":35579,"herbe":117850},"40":{"cer":118494,"herbe":23272},"41":{"cer":141005,"herbe":24299},"42":{"cer":23505,"herbe":157259},"43":{"cer":32075,"herbe":148561},"44":{"cer":76149,"herbe":121201},"45":{"cer":238703,"herbe":19367},"46":{"cer":24357,"herbe":136889},"47":{"cer":84411,"herbe":32120},"48":{"cer":15237,"herbe":190735},"49":{"cer":140256,"herbe":109850},"50":{"cer":64430,"herbe":208719},"51":{"cer":287517,"herbe":24071},"52":{"cer":126639,"herbe":97570},"53":{"cer":103555,"herbe":119488},"54":{"cer":115103,"herbe":85032},"55":{"cer":155242,"herbe":86812},"56":{"cer":107797,"herbe":67312},"57":{"cer":116131,"herbe":110656},"58":{"cer":97169,"herbe":194784},"59":{"cer":131991,"herbe":71998},"60":{"cer":203202,"herbe":30355},"61":{"cer":116290,"herbe":159534},"62":{"cer":203244,"herbe":74874},"63":{"cer":77120,"herbe":253167},"64":{"cer":92707,"herbe":163301},"65":{"cer":42588,"herbe":59423},"66":{"cer":1359,"herbe":31863},"67":{"cer":104117,"herbe":50965},"68":{"cer":75582,"herbe":27698},"69":{"cer":23999,"herbe":63413},"70":{"cer":68266,"herbe":107069},"71":{"cer":88304,"herbe":341195},"72":{"cer":157585,"herbe":107261},"73":{"cer":5783,"herbe":104386},"74":{"cer":10228,"herbe":99761},"75":{"cer":885,"herbe":66},"76":{"cer":143329,"herbe":101572},"77":{"cer":206832,"herbe":9532},"78":{"cer":57429,"herbe":6113},"79":{"cer":161922,"herbe":101186},"80":{"cer":226780,"herbe":33318},"81":{"cer":89698,"herbe":84219},"82":{"cer":69377,"herbe":41935},"83":{"cer":2671,"herbe":30824},"84":{"cer":9705,"herbe":16493},"85":{"cer":152226,"herbe":135902},"86":{"cer":206313,"herbe":57553},"87":{"cer":38029,"herbe":159840},"88":{"cer":43377,"herbe":121512},"89":{"cer":222640,"herbe":56928},"90":{"cer":5668,"herbe":4531},"91":{"cer":53845,"herbe":1327},"95":{"cer":38916,"herbe":3105},"2B":{"cer":1194,"herbe":85809},"07":{"cer":9575,"herbe":82557},"01":{"cer":92940,"herbe":86859},"06":{"cer":51,"herbe":37136},"04":{"cer":16978,"herbe":104108},"2A":{"cer":81,"herbe":58866},"02":{"cer":249330,"herbe":63780},"08":{"cer":116260,"herbe":109869},"09":{"cer":21090,"herbe":89976},"05":{"cer":7086,"herbe":50199},"03":{"cer":107366,"herbe":274246}}
;
var PLE_CHORO = 
{
  "10": {
    "betula": 3227,
    "alnus": 2618,
    "corylus": 7617,
    "platanus": 18,
    "populus": 5761,
    "cedrus": 4,
    "cupressus": 3,
    "olea": 16,
    "ambrosia": 141,
    "artemisia": 3012,
    "plantae": 990137
  },
  "11": {
    "betula": 490,
    "alnus": 636,
    "corylus": 1771,
    "platanus": 116,
    "populus": 2016,
    "cedrus": 143,
    "cupressus": 321,
    "olea": 1424,
    "ambrosia": 46,
    "artemisia": 678,
    "plantae": 999061
  },
  "12": {
    "betula": 553,
    "alnus": 854,
    "corylus": 1802,
    "platanus": 4,
    "populus": 715,
    "cedrus": 21,
    "cupressus": 3,
    "olea": 25,
    "ambrosia": 80,
    "artemisia": 539,
    "plantae": 544318
  },
  "13": {
    "betula": 5,
    "alnus": 255,
    "corylus": 261,
    "platanus": 175,
    "populus": 2979,
    "cedrus": 131,
    "cupressus": 298,
    "olea": 1756,
    "ambrosia": 99,
    "artemisia": 135,
    "plantae": 1003063
  },
  "14": {
    "betula": 1192,
    "corylus": 2520,
    "platanus": 17,
    "populus": 1094,
    "cedrus": 11,
    "cupressus": 4,
    "olea": 69,
    "ambrosia": 15,
    "artemisia": 1225,
    "plantae": 487911
  },
  "15": {
    "betula": 7176,
    "alnus": 5441,
    "corylus": 11027,
    "platanus": 13,
    "populus": 3597,
    "cedrus": 10,
    "olea": 1,
    "ambrosia": 512,
    "artemisia": 2415,
    "plantae": 1748492
  },
  "16": {
    "betula": 443,
    "alnus": 568,
    "corylus": 1784,
    "platanus": 10,
    "populus": 781,
    "cedrus": 20,
    "cupressus": 12,
    "olea": 71,
    "ambrosia": 1414,
    "artemisia": 417,
    "plantae": 238895
  },
  "17": {
    "betula": 444,
    "alnus": 697,
    "corylus": 2089,
    "platanus": 34,
    "populus": 2095,
    "cedrus": 23,
    "cupressus": 47,
    "olea": 395,
    "ambrosia": 387,
    "artemisia": 1119,
    "plantae": 595684
  },
  "18": {
    "betula": 3604,
    "alnus": 3391,
    "corylus": 7260,
    "platanus": 43,
    "populus": 4806,
    "cedrus": 16,
    "cupressus": 2,
    "olea": 35,
    "ambrosia": 1962,
    "artemisia": 4170,
    "plantae": 1403785
  },
  "19": {
    "betula": 4194,
    "alnus": 2228,
    "corylus": 4146,
    "platanus": 11,
    "populus": 1597,
    "cedrus": 9,
    "cupressus": 3,
    "olea": 36,
    "ambrosia": 174,
    "artemisia": 202,
    "plantae": 568463
  },
  "21": {
    "alnus": 3288,
    "corylus": 14958,
    "platanus": 25,
    "populus": 5308,
    "cedrus": 52,
    "cupressus": 9,
    "olea": 29,
    "ambrosia": 470,
    "artemisia": 4982,
    "plantae": 2192012
  },
  "22": {
    "betula": 1042,
    "alnus": 494,
    "corylus": 1881,
    "platanus": 1,
    "populus": 750,
    "cedrus": 8,
    "cupressus": 15,
    "olea": 127,
    "ambrosia": 9,
    "artemisia": 247,
    "plantae": 269360
  },
  "23": {
    "betula": 2936,
    "alnus": 1730,
    "corylus": 3266,
    "platanus": 20,
    "populus": 1260,
    "cedrus": 18,
    "cupressus": 5,
    "olea": 3,
    "ambrosia": 191,
    "artemisia": 510,
    "plantae": 378476
  },
  "24": {
    "betula": 871,
    "alnus": 1884,
    "corylus": 5543,
    "platanus": 37,
    "populus": 2061,
    "cedrus": 24,
    "cupressus": 19,
    "olea": 125,
    "ambrosia": 1213,
    "artemisia": 434,
    "plantae": 905055
  },
  "25": {
    "betula": 2396,
    "alnus": 1709,
    "corylus": 6203,
    "platanus": 12,
    "populus": 2141,
    "cedrus": 7,
    "ambrosia": 427,
    "artemisia": 830,
    "plantae": 1019831
  },
  "26": {
    "betula": 638,
    "alnus": 3597,
    "corylus": 5904,
    "platanus": 348,
    "populus": 11334,
    "cedrus": 181,
    "cupressus": 251,
    "olea": 492,
    "ambrosia": 5389,
    "plantae": 2190444
  },
  "27": {
    "betula": 4334,
    "alnus": 1646,
    "corylus": 3680,
    "platanus": 8,
    "populus": 1703,
    "cedrus": 16,
    "cupressus": 1,
    "olea": 43,
    "artemisia": 2401,
    "plantae": 749679
  },
  "28": {
    "betula": 4900,
    "alnus": 3322,
    "corylus": 7137,
    "platanus": 17,
    "populus": 3738,
    "cedrus": 11,
    "cupressus": 6,
    "olea": 36,
    "ambrosia": 23,
    "artemisia": 3410,
    "plantae": 1123793
  },
  "29": {
    "betula": 1736,
    "alnus": 910,
    "corylus": 2905,
    "platanus": 1,
    "populus": 1159,
    "cedrus": 7,
    "cupressus": 12,
    "olea": 195,
    "ambrosia": 24,
    "artemisia": 381,
    "plantae": 578497
  },
  "30": {
    "betula": 287,
    "alnus": 1019,
    "corylus": 749,
    "platanus": 228,
    "populus": 3299,
    "cedrus": 277,
    "cupressus": 234,
    "olea": 1233,
    "ambrosia": 1610,
    "artemisia": 273,
    "plantae": 757836
  },
  "31": {
    "betula": 564,
    "alnus": 1502,
    "corylus": 2854,
    "platanus": 97,
    "populus": 2975,
    "cedrus": 33,
    "cupressus": 70,
    "olea": 289,
    "ambrosia": 254,
    "artemisia": 1145,
    "plantae": 666787
  },
  "32": {
    "betula": 97,
    "alnus": 648,
    "corylus": 1009,
    "populus": 987,
    "cedrus": 7,
    "cupressus": 18,
    "olea": 80,
    "ambrosia": 147,
    "artemisia": 218,
    "plantae": 234936
  },
  "33": {
    "betula": 1989,
    "corylus": 3073,
    "platanus": 149,
    "populus": 3635,
    "cedrus": 48,
    "cupressus": 67,
    "olea": 467,
    "ambrosia": 221,
    "artemisia": 647,
    "plantae": 963933
  },
  "34": {
    "betula": 60,
    "alnus": 703,
    "corylus": 1122,
    "platanus": 448,
    "populus": 3126,
    "cedrus": 259,
    "cupressus": 513,
    "olea": 2539,
    "ambrosia": 148,
    "artemisia": 244,
    "plantae": 1403408
  },
  "35": {
    "betula": 2939,
    "alnus": 2632,
    "corylus": 4122,
    "platanus": 5,
    "populus": 2099,
    "cedrus": 32,
    "cupressus": 12,
    "olea": 144,
    "ambrosia": 23,
    "artemisia": 1372,
    "plantae": 918079
  },
  "36": {
    "betula": 1274,
    "alnus": 1516,
    "corylus": 3848,
    "platanus": 15,
    "populus": 2324,
    "cedrus": 10,
    "cupressus": 5,
    "olea": 14,
    "ambrosia": 279,
    "artemisia": 1541,
    "plantae": 834765
  },
  "37": {
    "betula": 2885,
    "alnus": 2600,
    "corylus": 6292,
    "platanus": 36,
    "populus": 4924,
    "cedrus": 22,
    "cupressus": 29,
    "olea": 116,
    "ambrosia": 336,
    "artemisia": 5509,
    "plantae": 1456241
  },
  "38": {
    "betula": 14091,
    "alnus": 21062,
    "corylus": 27610,
    "platanus": 237,
    "populus": 16032,
    "cedrus": 60,
    "cupressus": 29,
    "olea": 151,
    "ambrosia": 8387,
    "artemisia": 5638,
    "plantae": 4976958
  },
  "39": {
    "betula": 1991,
    "alnus": 2427,
    "corylus": 5945,
    "platanus": 3,
    "populus": 2524,
    "cedrus": 8,
    "cupressus": 2,
    "olea": 11,
    "ambrosia": 7042,
    "artemisia": 1013,
    "plantae": 941529
  },
  "40": {
    "betula": 646,
    "alnus": 2830,
    "corylus": 2740,
    "platanus": 382,
    "populus": 1443,
    "cedrus": 12,
    "cupressus": 14,
    "olea": 109,
    "ambrosia": 247,
    "artemisia": 92,
    "plantae": 647632
  },
  "41": {
    "betula": 4896,
    "alnus": 2290,
    "corylus": 4525,
    "platanus": 23,
    "populus": 4332,
    "cedrus": 32,
    "cupressus": 7,
    "olea": 35,
    "ambrosia": 345,
    "artemisia": 4252,
    "plantae": 1108505
  },
  "42": {
    "betula": 3432,
    "alnus": 3160,
    "corylus": 4875,
    "platanus": 54,
    "populus": 4453,
    "cedrus": 60,
    "cupressus": 8,
    "olea": 53,
    "ambrosia": 1739,
    "artemisia": 3300,
    "plantae": 1155049
  },
  "43": {
    "betula": 4322,
    "alnus": 2191,
    "corylus": 4920,
    "platanus": 8,
    "populus": 2910,
    "cedrus": 33,
    "cupressus": 5,
    "olea": 4,
    "ambrosia": 270,
    "artemisia": 2279,
    "plantae": 1047609
  },
  "44": {
    "betula": 792,
    "alnus": 1118,
    "corylus": 1781,
    "platanus": 23,
    "populus": 1745,
    "cedrus": 43,
    "cupressus": 31,
    "olea": 308,
    "ambrosia": 33,
    "artemisia": 588
  },
  "45": {
    "betula": 5097,
    "alnus": 3012,
    "corylus": 6842,
    "platanus": 76,
    "populus": 6754,
    "cedrus": 28,
    "cupressus": 9,
    "olea": 66,
    "ambrosia": 890,
    "artemisia": 6729,
    "plantae": 1505012
  },
  "46": {
    "betula": 294,
    "alnus": 345,
    "corylus": 1151,
    "platanus": 14,
    "populus": 508,
    "cedrus": 38,
    "cupressus": 1,
    "olea": 52,
    "ambrosia": 350,
    "artemisia": 147,
    "plantae": 287629
  },
  "47": {
    "betula": 147,
    "alnus": 694,
    "corylus": 1377,
    "platanus": 48,
    "populus": 1297,
    "cedrus": 25,
    "cupressus": 32,
    "olea": 99,
    "ambrosia": 362,
    "artemisia": 227,
    "plantae": 354637
  },
  "48": {
    "betula": 2234,
    "alnus": 724,
    "corylus": 1183,
    "platanus": 20,
    "populus": 588,
    "cedrus": 48,
    "cupressus": 1,
    "olea": 15,
    "ambrosia": 91,
    "artemisia": 524,
    "plantae": 437481
  },
  "49": {
    "betula": 1010,
    "alnus": 1087,
    "corylus": 2422,
    "platanus": 16,
    "populus": 2017,
    "cedrus": 13,
    "cupressus": 19,
    "olea": 161,
    "ambrosia": 26,
    "artemisia": 1542,
    "plantae": 594925
  },
  "50": {
    "betula": 864,
    "alnus": 799,
    "corylus": 1274,
    "platanus": 2,
    "populus": 790,
    "cupressus": 5,
    "olea": 77,
    "ambrosia": 11,
    "artemisia": 408,
    "plantae": 269082
  },
  "51": {
    "betula": 6145,
    "alnus": 5127,
    "corylus": 10227,
    "platanus": 19,
    "populus": 7635,
    "cedrus": 6,
    "cupressus": 2,
    "olea": 30,
    "ambrosia": 51,
    "artemisia": 5712,
    "plantae": 1332499
  },
  "52": {
    "betula": 1942,
    "alnus": 2701,
    "corylus": 10897,
    "platanus": 7,
    "populus": 3430,
    "olea": 4,
    "ambrosia": 179,
    "artemisia": 1943,
    "plantae": 1125962
  },
  "53": {
    "betula": 862,
    "alnus": 986,
    "corylus": 1619,
    "platanus": 2,
    "populus": 731,
    "cedrus": 11,
    "cupressus": 2,
    "olea": 39,
    "ambrosia": 1,
    "artemisia": 409,
    "plantae": 319228
  },
  "54": {
    "betula": 960,
    "alnus": 611,
    "corylus": 2662,
    "platanus": 8,
    "populus": 1053,
    "cedrus": 18,
    "cupressus": 4,
    "olea": 18,
    "ambrosia": 32,
    "artemisia": 655,
    "plantae": 300348
  },
  "55": {
    "betula": 1442,
    "alnus": 639,
    "corylus": 3504,
    "platanus": 1,
    "populus": 1340,
    "cedrus": 4,
    "olea": 2,
    "ambrosia": 5,
    "artemisia": 545,
    "plantae": 284882
  },
  "56": {
    "betula": 1508,
    "alnus": 674,
    "corylus": 1486,
    "platanus": 6,
    "populus": 893,
    "cedrus": 7,
    "cupressus": 10,
    "olea": 210,
    "ambrosia": 30,
    "artemisia": 289,
    "plantae": 307225
  },
  "57": {
    "betula": 1040,
    "alnus": 741,
    "corylus": 1888,
    "platanus": 8,
    "populus": 1024,
    "cedrus": 14,
    "cupressus": 5,
    "olea": 39,
    "ambrosia": 29,
    "artemisia": 647,
    "plantae": 300407
  },
  "58": {
    "betula": 4340,
    "alnus": 4237,
    "corylus": 7362,
    "platanus": 2,
    "populus": 5498,
    "cedrus": 8,
    "cupressus": 2,
    "olea": 15,
    "ambrosia": 1669,
    "artemisia": 2321,
    "plantae": 1229550
  },
  "59": {
    "betula": 6570,
    "alnus": 7079,
    "corylus": 7825,
    "platanus": 39,
    "populus": 5526,
    "cedrus": 23,
    "cupressus": 7,
    "olea": 104,
    "ambrosia": 67,
    "artemisia": 8257,
    "plantae": 1606840
  },
  "60": {
    "betula": 4038,
    "alnus": 1963,
    "corylus": 5909,
    "platanus": 10,
    "populus": 2839,
    "cedrus": 12,
    "cupressus": 12,
    "olea": 51,
    "ambrosia": 29,
    "artemisia": 2936,
    "plantae": 857788
  },
  "61": {
    "betula": 1716,
    "alnus": 1108,
    "corylus": 1946,
    "platanus": 2,
    "populus": 900,
    "cedrus": 13,
    "cupressus": 3,
    "olea": 27,
    "ambrosia": 8,
    "artemisia": 399,
    "plantae": 291605
  },
  "62": {
    "betula": 4345,
    "alnus": 4759,
    "corylus": 7066,
    "platanus": 19,
    "populus": 4516,
    "cedrus": 8,
    "cupressus": 1,
    "olea": 57,
    "ambrosia": 24,
    "artemisia": 6581,
    "plantae": 1549689
  },
  "63": {
    "betula": 7082,
    "alnus": 4557,
    "corylus": 11011,
    "platanus": 87,
    "populus": 6586,
    "cedrus": 162,
    "cupressus": 22,
    "olea": 50,
    "ambrosia": 1507,
    "artemisia": 3802,
    "plantae": 2025092
  },
  "64": {
    "betula": 1367,
    "alnus": 3435,
    "corylus": 7051,
    "platanus": 664,
    "populus": 1591,
    "cedrus": 14,
    "cupressus": 20,
    "olea": 109,
    "ambrosia": 34,
    "artemisia": 171
  },
  "65": {
    "betula": 1947,
    "alnus": 1461,
    "corylus": 4186,
    "platanus": 65,
    "populus": 1345,
    "cedrus": 14,
    "cupressus": 7,
    "olea": 39,
    "ambrosia": 42,
    "artemisia": 337,
    "plantae": 771257
  },
  "66": {
    "betula": 1715,
    "alnus": 4273,
    "corylus": 2207,
    "platanus": 150,
    "populus": 2932,
    "cedrus": 146,
    "cupressus": 342,
    "olea": 2104,
    "ambrosia": 32,
    "artemisia": 1206,
    "plantae": 1395462
  },
  "67": {
    "betula": 2244,
    "alnus": 4065,
    "corylus": 4208,
    "platanus": 277,
    "populus": 3077,
    "cedrus": 43,
    "cupressus": 13,
    "olea": 40,
    "ambrosia": 151,
    "artemisia": 1601,
    "plantae": 710947
  },
  "68": {
    "betula": 981,
    "alnus": 1502,
    "corylus": 2659,
    "platanus": 64,
    "populus": 1519,
    "cedrus": 22,
    "cupressus": 12,
    "olea": 29,
    "ambrosia": 186,
    "artemisia": 881,
    "plantae": 526569
  },
  "69": {
    "betula": 1049,
    "alnus": 2333,
    "corylus": 5314,
    "platanus": 344,
    "populus": 5020,
    "cedrus": 184,
    "cupressus": 58,
    "olea": 190,
    "ambrosia": 7271,
    "artemisia": 4100,
    "plantae": 1058157
  },
  "70": {
    "betula": 1904,
    "alnus": 3072,
    "corylus": 3967,
    "platanus": 1,
    "populus": 1522,
    "cedrus": 8,
    "cupressus": 2,
    "olea": 7,
    "ambrosia": 122,
    "artemisia": 773,
    "plantae": 520843
  },
  "71": {
    "betula": 5513,
    "alnus": 6311,
    "corylus": 9723,
    "platanus": 17,
    "populus": 5890,
    "cedrus": 47,
    "cupressus": 8,
    "olea": 45,
    "ambrosia": 2223,
    "artemisia": 3333,
    "plantae": 1800868
  },
  "72": {
    "betula": 3311,
    "alnus": 2322,
    "corylus": 4930,
    "platanus": 8,
    "populus": 2408,
    "cedrus": 15,
    "cupressus": 3,
    "olea": 55,
    "ambrosia": 66,
    "artemisia": 3129,
    "plantae": 1035500
  },
  "73": {
    "betula": 4571,
    "alnus": 7086,
    "corylus": 7374,
    "platanus": 11,
    "populus": 4619,
    "cedrus": 34,
    "cupressus": 10,
    "olea": 54,
    "ambrosia": 1040,
    "artemisia": 1516,
    "plantae": 2451897
  },
  "74": {
    "betula": 5066,
    "alnus": 10017,
    "corylus": 8108,
    "platanus": 65,
    "populus": 8420,
    "cedrus": 47,
    "cupressus": 5,
    "ambrosia": 498,
    "artemisia": 996,
    "plantae": 2244816
  },
  "75": {
    "betula": 200,
    "alnus": 273,
    "corylus": 561,
    "platanus": 220,
    "populus": 508,
    "cedrus": 106,
    "cupressus": 26,
    "olea": 135,
    "ambrosia": 21,
    "artemisia": 1168,
    "plantae": 202003
  },
  "76": {
    "betula": 4628,
    "alnus": 1489,
    "corylus": 3457,
    "platanus": 6,
    "populus": 1467,
    "cedrus": 10,
    "cupressus": 3,
    "olea": 63,
    "ambrosia": 35,
    "artemisia": 2217,
    "plantae": 737936
  },
  "77": {
    "betula": 9519,
    "alnus": 5410,
    "corylus": 16652,
    "platanus": 115,
    "populus": 10176,
    "cedrus": 75,
    "cupressus": 41,
    "olea": 122,
    "ambrosia": 62,
    "artemisia": 8831,
    "plantae": 2154636
  },
  "78": {
    "betula": 10640,
    "alnus": 4524,
    "corylus": 9894,
    "platanus": 81,
    "populus": 5804,
    "cedrus": 43,
    "cupressus": 16,
    "olea": 162,
    "ambrosia": 55,
    "artemisia": 6769,
    "plantae": 1553849
  },
  "79": {
    "betula": 152,
    "alnus": 814,
    "corylus": 1222,
    "platanus": 9,
    "cedrus": 13,
    "olea": 79,
    "ambrosia": 428,
    "artemisia": 298,
    "plantae": 248427
  },
  "80": {
    "betula": 2255,
    "alnus": 1639,
    "corylus": 3939,
    "platanus": 4,
    "populus": 2080,
    "cedrus": 10,
    "cupressus": 3,
    "olea": 26,
    "ambrosia": 21,
    "artemisia": 2665,
    "plantae": 797696
  },
  "81": {
    "betula": 177,
    "alnus": 471,
    "corylus": 1148,
    "platanus": 31,
    "populus": 576,
    "cedrus": 28,
    "cupressus": 22,
    "olea": 105,
    "ambrosia": 135,
    "artemisia": 351,
    "plantae": 257530
  },
  "82": {
    "alnus": 188,
    "corylus": 343,
    "platanus": 18,
    "populus": 453,
    "cedrus": 17,
    "cupressus": 10,
    "olea": 57,
    "ambrosia": 292,
    "artemisia": 105,
    "plantae": 118081
  },
  "83": {
    "betula": 20,
    "alnus": 1754,
    "corylus": 1391,
    "platanus": 409,
    "populus": 3884,
    "cedrus": 227,
    "cupressus": 336,
    "olea": 3743,
    "ambrosia": 39,
    "artemisia": 224,
    "plantae": 1499556
  },
  "84": {
    "betula": 20,
    "alnus": 710,
    "corylus": 913,
    "platanus": 246,
    "populus": 4526,
    "cedrus": 766,
    "cupressus": 230,
    "olea": 760,
    "artemisia": 364,
    "plantae": 789781
  },
  "85": {
    "betula": 245,
    "alnus": 682,
    "corylus": 1071,
    "platanus": 3,
    "populus": 1015,
    "cedrus": 13,
    "cupressus": 24,
    "olea": 207,
    "ambrosia": 20,
    "artemisia": 318,
    "plantae": 258054
  },
  "86": {
    "betula": 364,
    "alnus": 844,
    "corylus": 1966,
    "platanus": 15,
    "populus": 1523,
    "cedrus": 16,
    "cupressus": 6,
    "olea": 52,
    "ambrosia": 167,
    "artemisia": 684,
    "plantae": 353546
  },
  "87": {
    "betula": 4355,
    "alnus": 2515,
    "corylus": 50,
    "platanus": 29,
    "populus": 1863,
    "cedrus": 26,
    "cupressus": 4,
    "olea": 25,
    "ambrosia": 219,
    "artemisia": 428,
    "plantae": 517556
  },
  "88": {
    "betula": 2018,
    "alnus": 999,
    "corylus": 2349,
    "platanus": 2,
    "populus": 955,
    "cedrus": 5,
    "cupressus": 1,
    "olea": 2,
    "ambrosia": 30,
    "artemisia": 328,
    "plantae": 320824
  },
  "89": {
    "betula": 5098,
    "alnus": 3570,
    "corylus": 11577,
    "platanus": 7,
    "populus": 6651,
    "cedrus": 14,
    "cupressus": 2,
    "olea": 32,
    "ambrosia": 93,
    "artemisia": 5191,
    "plantae": 1697388
  },
  "90": {
    "betula": 442,
    "alnus": 846,
    "corylus": 966,
    "platanus": 1,
    "populus": 397,
    "cedrus": 4,
    "olea": 1,
    "ambrosia": 42,
    "artemisia": 218,
    "plantae": 177062
  },
  "91": {
    "betula": 5986,
    "alnus": 3591,
    "corylus": 9804,
    "platanus": 106,
    "populus": 5671,
    "cedrus": 21,
    "cupressus": 28,
    "olea": 114,
    "ambrosia": 91,
    "artemisia": 7351,
    "plantae": 1583236
  },
  "92": {
    "betula": 538,
    "alnus": 561,
    "corylus": 1185,
    "platanus": 58,
    "populus": 779,
    "cedrus": 66,
    "cupressus": 14,
    "olea": 84,
    "ambrosia": 19,
    "artemisia": 2384,
    "plantae": 302557
  },
  "93": {
    "betula": 1046,
    "alnus": 470,
    "corylus": 2042,
    "platanus": 91,
    "populus": 1225,
    "cedrus": 9,
    "cupressus": 14,
    "olea": 76,
    "ambrosia": 24,
    "artemisia": 3280,
    "plantae": 394118
  },
  "94": {
    "betula": 964,
    "alnus": 819,
    "corylus": 1294,
    "platanus": 186,
    "populus": 1273,
    "cedrus": 12,
    "cupressus": 18,
    "olea": 117,
    "ambrosia": 11,
    "artemisia": 2146,
    "plantae": 281504
  },
  "95": {
    "betula": 4359,
    "alnus": 2973,
    "corylus": 7541,
    "platanus": 63,
    "populus": 3139,
    "cedrus": 17,
    "cupressus": 10,
    "olea": 127,
    "ambrosia": 29,
    "artemisia": 4894,
    "plantae": 920507
  },
  "05": {
    "betula": 8502,
    "alnus": 10954,
    "corylus": 7714,
    "platanus": 5,
    "populus": 12570,
    "cedrus": 100,
    "cupressus": 7,
    "olea": 16,
    "ambrosia": 278,
    "artemisia": 1840,
    "plantae": 2632642
  },
  "08": {
    "betula": 4810,
    "alnus": 3339,
    "corylus": 6221,
    "platanus": 7,
    "populus": 2849,
    "cedrus": 2,
    "olea": 3,
    "ambrosia": 21,
    "artemisia": 2030,
    "plantae": 768863
  },
  "02": {
    "betula": 4150,
    "alnus": 3279,
    "corylus": 5651,
    "platanus": 2,
    "populus": 3697,
    "cedrus": 2,
    "cupressus": 2,
    "olea": 25,
    "ambrosia": 23,
    "artemisia": 2655,
    "plantae": 876305
  },
  "01": {
    "betula": 2521,
    "alnus": 4520,
    "corylus": 9336,
    "platanus": 66,
    "populus": 5532,
    "cedrus": 17,
    "cupressus": 17,
    "olea": 70,
    "ambrosia": 3002,
    "artemisia": 2866,
    "plantae": 1637356
  },
  "03": {
    "betula": 1512,
    "alnus": 1900,
    "corylus": 3226,
    "platanus": 52,
    "populus": 3211,
    "cedrus": 15,
    "cupressus": 1,
    "olea": 23,
    "ambrosia": 2220,
    "artemisia": 1877,
    "plantae": 695517
  },
  "04": {
    "betula": 1333,
    "alnus": 2398,
    "corylus": 3598,
    "platanus": 58,
    "populus": 7754,
    "cedrus": 375,
    "cupressus": 71,
    "olea": 635,
    "ambrosia": 278,
    "artemisia": 952,
    "plantae": 2150348
  },
  "07": {
    "betula": 1269,
    "alnus": 2686,
    "corylus": 2891,
    "platanus": 192,
    "populus": 4641,
    "cedrus": 452,
    "cupressus": 102,
    "olea": 499,
    "ambrosia": 2722,
    "artemisia": 1727,
    "plantae": 1463035
  },
  "09": {
    "betula": 1036,
    "alnus": 682,
    "corylus": 2585,
    "platanus": 34,
    "populus": 750,
    "cedrus": 10,
    "cupressus": 10,
    "olea": 33,
    "ambrosia": 327,
    "artemisia": 389,
    "plantae": 434055
  },
  "06": {
    "betula": 329,
    "alnus": 1659,
    "corylus": 3644,
    "platanus": 203,
    "populus": 1994,
    "cedrus": 79,
    "cupressus": 122,
    "olea": 1662,
    "ambrosia": 51,
    "artemisia": 570,
    "plantae": 1324980
  },
  "2B": {
    "betula": 230,
    "alnus": 2794,
    "corylus": 169,
    "platanus": 25,
    "populus": 311,
    "cedrus": 7,
    "cupressus": 37,
    "olea": 1434,
    "ambrosia": 6,
    "artemisia": 45,
    "plantae": 434217
  },
  "2A": {
    "betula": 74,
    "alnus": 834,
    "corylus": 26,
    "platanus": 11,
    "populus": 99,
    "cedrus": 9,
    "cupressus": 21,
    "olea": 1428,
    "ambrosia": 10,
    "artemisia": 28,
    "plantae": 284850
  }
}
;

// ---------- Données statiques (superficies km2, IFN ha, Agreste ha, GBIF n) ----------

function pleInd(id) {
  for (var i = 0; i < PLE_ES.length; i++) if (PLE_ES[i].id === id) return PLE_ES[i];
  return null;
}
function pleMois(cal) { return PLE_MOIS[cal[0] - 1] + ' – ' + PLE_MOIS[cal[1] - 1]; }
function pleTaxonLabel(id) {
  if (typeof plTaxon === 'function') { var t = plTaxon(id); if (t) return t.label; }
  return id;
}
function pleSource(ind) {
  if (ind.groupe === 'ifn') {
    return 'IFN — « Superficie de forêt par essence » (Ecolab, data.gouv 6a471c45e8b3be060f779d2f, millésime 2024, licence ouverte) : ' +
      'hectares par essence (90 départements) ; indicateur = part de la superficie du département.';
  }
  if (ind.groupe === 'choro') {
    return 'GBIF (api.gbif.org) — occurrences agrégées par département (collecte 10/2026) : part des occurrences de l\'essence parmi celles des plantes ' +
      'du département (dénominateur d\'effort). INDICATIF : biais d\'échantillonnage (inventaires, données participatives, effectifs urbains).';
  }
  return 'Agreste — RGA 2020 « SAU par EPCI » (TACCT), agrégé par département via BANATIC : proxy cultures de graminées (hectares).';
}

// ---------- Calcul : exposition relative 1-5 (quintiles) ----------
function pleQuintileIx(pairs) { // pairs: [{code, m}] -> {code: ix 1..5}
  var out = {};
  if (!pairs.length) return out;
  var arr = pairs.map(function (p) { return p.m; }).sort(function (a, b) { return b - a; });
  var n = arr.length;
  // seuils : les 20 % les plus exposés -> 5, puis 40 % -> 4, etc.
  var th = [arr[Math.floor((n - 1) * 0.8)], arr[Math.floor((n - 1) * 0.6)],
            arr[Math.floor((n - 1) * 0.4)], arr[Math.floor((n - 1) * 0.2)]];
  pairs.forEach(function (p) {
    var ix = 1;
    if (p.m >= th[3]) ix = 5;
    else if (p.m >= th[2]) ix = 4;
    else if (p.m >= th[1]) ix = 3;
    else if (p.m >= th[0]) ix = 2;
    out[p.code] = ix;
  });
  return out;
}

function pleCompute(ind) {
  var pairs = [], vals = {};
  for (var code in PLE_DEP_AREA) {
    var m = null, disp = '', lines = [];
    if (ind.groupe === 'ifn') {
      var rec = PLE_IFN[code];
      if (!rec) continue; // departement non couvert par l'IFN (ex. petites departements urbaines)
      var ha = 0;
      for (var i = 0; i < ind.champs.length; i++) { var h = rec[ind.champs[i]]; if (h) ha += h; }
      var dens = ha / PLE_DEP_AREA[code] * 100;
      m = dens;
      disp = fmt(ha) + ' ha';
      lines.push('soit ' + dens.toFixed(1) + ' % de la superficie du departement');
    } else if (ind.groupe === 'agri') {
      var ag = PLE_AGRI[code];
      if (!ag) continue;
      var ha2 = ag[ind.champ] || 0;
      var dens2 = ha2 / PLE_DEP_AREA[code] * 100;
      m = dens2;
      disp = fmt(ha2) + ' ha';
      lines.push('soit ' + dens2.toFixed(1) + ' % de la superficie du departement');
    } else { // choro
      var ch = PLE_CHORO[code];
      if (!ch) continue;
      var n = ch[ind.id] || 0;
      var den = ch.plantae || 0;
      if (n < 3 || !den) continue; // occurrences trop rares -> non significatif
      var share = n / den * 100;
      m = share;
      disp = fmt(n) + ' occurrence' + (n > 1 ? 's' : '');
      lines.push('part relative : ' + share.toFixed(2) + ' % des occurrences de plantes (indicatif)');
    }
    pairs.push({ code: code, m: m });
    vals[code] = { m: m, disp: disp, ix: 1, lines: lines };
  }
  var ixs = pleQuintileIx(pairs);
  for (var c2 in ixs) if (vals[c2]) vals[c2].ix = ixs[c2];
  return vals;
}

// ---------- Rendu ----------
var PLE_GEO_PROM = null;
function pleDepsGeo() { // contours departements (proxy /data/departements.json, cache app.js)
  if (!PLE_GEO_PROM) {
    PLE_GEO_PROM = fetchJSONCached('/data/departements.json').then(function (g) {
      var feats = (g.features || []).filter(function (f) { return !!PLE_DEP_AREA[f.properties.code]; });
      return { type: 'FeatureCollection', features: feats };
    });
  }
  return PLE_GEO_PROM;
}

function pleDraw() {
  if (!PLE.active || !PLE.ind) return;
  var ind = PLE.ind;
  var vals = pleCompute(ind);
  PLE.vals = vals;
  pleDepsGeo().then(function (geo) {
    if (!PLE.active) return; // reponse obsolète (changement de vue entre-temps)
    if (PLE.layer) { map.removeLayer(PLE.layer); PLE.layer = null; }
    PLE.layer = L.geoJSON(geo, {
      style: function (f) {
        var v = vals[f.properties.code];
        return { weight: 1, color: '#0f172a',
                 fillColor: v ? PLE_COLORS[v.ix - 1] : PLE_GREY,
                 fillOpacity: v ? 0.85 : 0.25 };
      },
      onEachFeature: function (f, l) {
        l.bindTooltip(function () { // live : suit l'indicateur sans rebind
          var code = f.properties.code;
          var v = vals[code];
          var html = '<b>' + esc(depNom(code)) + ' (' + code + ')</b>';
          if (!v) html += '<br><i>Pas de données</i>';
          else {
            html += '<br>' + esc(ind.label) + ' : <b style="color:' + PLE_COLORS[v.ix - 1] + '">' + v.disp + '</b>';
            html += '<br>Exposition relative : <b>' + v.ix + '/5 — ' + PLE_IX_LABELS[v.ix - 1] + '</b>';
            v.lines.forEach(function (x) { html += '<br><span class="muted">' + x + '</span>'; });
          }
          return html;
        }, { sticky: true });
      }
    }).addTo(map);
    map.fitBounds(PLE.layer.getBounds(), { padding: [30, 30] });
    pleLegend(ind);
    pleResults(vals, ind);
    pleStatus(ind, vals);
  }).catch(function (err) {
    console.error('[OpenFrance] Pollens essences :', err);
    setStatus('Erreur pollens (essences)');
    showError('Impossible de charger les contours des départements.', err.message);
  });
}

function pleLegend(ind) {
  var el = document.getElementById('plLegend');
  var html = '';
  PLE_IX_LABELS.forEach(function (lb, i) {
    html += '<div class="legend-row"><span class="legend-color" style="background:' + PLE_COLORS[i] + '"></span>' +
            '<span>' + (i + 1) + ' — ' + lb + '</span></div>';
  });
  html += '<div class="legend-row"><span class="legend-color" style="background:' + PLE_GREY + '"></span>' +
          '<span>Pas de données / absent</span></div>';
  html += '<div class="muted" style="margin-top:6px">Exposition relative par quintiles (5 = les 20 % de départements les plus exposés).<br>' +
          esc(ind.label) + ' — ' + esc(PLE_GR_LIB[ind.groupe]) + '</div>';
  el.innerHTML = html;
}

function pleResults(vals, ind) { // top 15 : aide au déménagement
  var el = document.getElementById('plResults');
  var arr = [];
  for (var c in vals) arr.push({ code: c, m: vals[c].m, ix: vals[c].ix, disp: vals[c].disp });
  arr.sort(function (a, b) { return b.m - a.m || (depNom(a.code) < depNom(b.code) ? -1 : 1); });
  var html = '<p class="muted" style="margin:4px 0 2px">Top 15 départements — ' + esc(ind.label) +
    ' (' + esc(PLE_GR_LIB[ind.groupe]) + ') · classement par exposition</p>';
  arr.slice(0, 15).forEach(function (a, i) {
    html += '<div class="top-row"><span>' + (i + 1) + '. ' + esc(depNom(a.code)) + ' (' + a.code + ')</span>' +
      '<span style="color:' + PLE_COLORS[a.ix - 1] + '"><b>' + a.disp + '</b> · ' + a.ix + '/5</span></div>';
  });
  el.innerHTML = html;
}

function pleStatus(ind, vals) {
  var n = 0; for (var c in vals) n++;
  var html = '<b>' + esc(ind.label) + '</b> — exposition relative par département (échelle 1–5, quintiles) · ' +
    n + ' département(s) avec données.';
  if (state.zone && state.zone.length) {
    html += ' Vue structurelle : toute la France est affichée (la zone ' + esc(zoneLabel(state.zone)) +
      ' sert surtout à la vue « Indice quotidien »).';
  }
  html += '<br><span class="muted">' + pleSource(ind) + '</span>' +
    '<br><span class="muted">Vue « en général » (déménagement) — pour l\'indice du jour, voir la vue « Indice quotidien ». ' +
    'Notation allergénique et calendriers : RNSA / ANSES (indicatif).</span>';
  document.getElementById('plStatus').innerHTML = html;
}

function pleInfoUpdate(ind) {
  var el = document.getElementById('plEsInfo');
  if (!ind) { el.innerHTML = ''; el.style.display = 'none'; return; }
  var html = '<b>' + esc(ind.label) + '</b>' + (ind.latin ? ' <i>(' + esc(ind.latin) + ')</i>' : '');
  if (ind.notation !== null && typeof plNotationDots === 'function') {
    html += '<br>Allergénicité indicative : <b>' + plNotationDots(ind.notation) + '</b> ' + ind.notation + '/5';
  }
  if (ind.cal) html += '<br>Pollinisation : <b>' + pleMois(ind.cal) + '</b> (RNSA, indicatif)';
  if (ind.note) html += '<br><span class="muted">' + esc(ind.note) + '</span>';
  if (ind.taxon) {
    html += '<br><span class="muted">Essence suivie par l\'indice quotidien (taxon « ' + esc(pleTaxonLabel(ind.taxon)) +
      ' ») — détails par commune dans la vue « Indice quotidien ».</span>';
  }
  el.innerHTML = html;
  el.style.display = '';
}

// ---------- Bascule des vues (quotidien <-> structurel) ----------
function pleShowView(v) {
  var jour = (v !== 'ess');
  var taxLab = document.getElementById('plTaxon').closest('label');
  var echLab = document.getElementById('plEcheance').closest('label');
  taxLab.style.display = jour ? '' : 'none';
  echLab.style.display = jour ? '' : 'none';
  document.getElementById('plEssWrap').style.display = jour ? '' : 'none';
  document.getElementById('plEsWrap').style.display = jour ? 'none' : '';
  document.getElementById('plNotation').style.display = 'none'; // recréée par la vue active
  if (jour) {
    if (PLE.layer) { map.removeLayer(PLE.layer); PLE.layer = null; }
    PLE.active = false;
    if (PLE.prevRefresh) { refresh = PLE.prevRefresh; PLE.prevRefresh = null; }
    pleInfoUpdate(null);
    document.getElementById('plLegend').innerHTML = '';
    document.getElementById('plResults').innerHTML = '';
    if (POL.active && typeof refresh === 'function') refresh(); // re-rendu quotidien (cache : instantané)
  } else {
    PLE.active = true;
    if (!PLE.prevRefresh) PLE.prevRefresh = refresh;
    refresh = pleRefresh; // clics de zone / retours France : garder la carte essences
    if (POL.active && POL.layer) { map.removeLayer(POL.layer); POL.layer = null; }
    document.getElementById('backBtn').hidden = true;
    document.getElementById('levelTitle').textContent = 'Pollens — essences & exposition (France)';
    pleInfoUpdate(PLE.ind);
    pleDraw();
    setStatus('🌳 Pollens — essences & exposition (structurel)');
  }
}

function pleRefresh() { // refresh() tant que la vue structurelle est active
  if (!PLE.active) return;
  pleDraw();
}

function pleLeaveCleanup() { // sortie de la catégorie Pollens (plLeave de pollens.js a déjà restauré refresh)
  if (PLE.layer) { map.removeLayer(PLE.layer); PLE.layer = null; }
  PLE.active = false;
  PLE.prevRefresh = null;
  PLE.view = 'jour';
  var v = document.getElementById('plView'); if (v) v.value = 'jour';
  ['plTaxon', 'plEcheance'].forEach(function (id) {
    var s = document.getElementById(id);
    var l = s && s.closest ? s.closest('label') : null;
    if (l) l.style.display = '';
  });
  var ew = document.getElementById('plEssWrap'); if (ew) ew.style.display = '';
  var w = document.getElementById('plEsWrap'); if (w) w.style.display = 'none';
  var i = document.getElementById('plEsInfo'); if (i) { i.innerHTML = ''; i.style.display = 'none'; }
}

// ---------- Critère « Essence & exposition (structurel) » du Composeur ----------
// pollens-essences.js s'enregistre dans SC_TYPES au chargement (comme pollens.js
// pour l'indice quotidien) : aucune modification de score.js. Valeur = exposition
// relative 1-5 du DÉPARTEMENT de la commune — CONSTANTE au sein d'un département
// (utile surtout pour départager les départements d'une zone multi-départements) ;
// département non couvert par la source -> commune absente -> part neutre.
// Sens ⬇ par défaut : moins d'exposition = mieux.
var PLE_ZONE_COMMUNES = { zk: null, codes: [] };
if (typeof SC_TYPES !== 'undefined') {
  SC_TYPES.ples = {
    icon: '🌳', label: 'Essence & exposition (département, structurel)', dir: 'min', cfg: 'select', field: 'ind',
    defCfg: function () { return { ind: 'betula' }; },
    key: function (cfg) { return 'ples|' + cfg.ind; },
    cfgOptions: function () {
      return PLE_ES.map(function (e) {
        return { v: e.id, l: e.label + ' — exposition 1–5 (' + PLE_GR_LIB[e.groupe] + ')' };
      });
    },
    describe: function (cfg) {
      var e = pleInd(cfg.ind);
      return 'Exposition ' + (e ? e.label : '?') + ' (département — ' + (e ? PLE_GR_LIB[e.groupe] : '') + ')';
    },
    defDir: function () { return 'min'; },
    ensure: function () { // précharge la liste des communes de la zone (geo déjà en cache app.js)
      return mergedZoneGeo(SC.zone.slice()).then(function (geo) {
        var codes = [];
        (geo.features || []).forEach(function (f) { var c = f.properties && f.properties.code; if (c) codes.push(c); });
        PLE_ZONE_COMMUNES = { zk: SC.zone.join('+'), codes: codes };
      });
    },
    vals: function (cfg) {
      var ind = pleInd(cfg.ind) || PLE_ES[0];
      var computed = pleCompute(ind);
      var out = {};
      if (PLE_ZONE_COMMUNES.zk !== SC.zone.join('+')) return out; // zone non encore chargée par ensure()
      PLE_ZONE_COMMUNES.codes.forEach(function (c) {
        var v = computed[depOfCommune(c)];
        if (v) out[c] = v.ix; // département non couvert -> absent (part neutre)
      });
      return out;
    },
    fmt: function (v) { return v + '/5'; }
  };
}

// ---------- Branchement UI ----------
function pleInitUI() {
  var catSel = document.getElementById('categorySelect');
  catSel.addEventListener('change', function () {
    if (this.value !== 'pollens') pleLeaveCleanup(); // pollens.js gère plEnter/plLeave quotidien
  });

  // Sélecteur d'exposition : 3 groupes de sources
  var sel = document.getElementById('plEsSel');
  var groups = { ifn: [], choro: [], agri: [] };
  PLE_ES.forEach(function (e) { groups[e.groupe].push(e); });
  var html = '';
  [
    ['ifn', 'Forêts — superficie forestière (IFN 2024)'],
    ['choro', 'Chorologie indicative (occurrences GBIF)'],
    ['agri', 'Graminées cultivées (Agreste RGA 2020)']
  ].forEach(function (g) {
    html += '<optgroup label="' + esc(g[1]) + '">';
    groups[g[0]].forEach(function (e) {
      html += '<option value="' + e.id + '">' + esc(e.label) + ' — allergénicité ' + e.notation + '/5</option>';
    });
    html += '</optgroup>';
  });
  sel.innerHTML = html;
  PLE.ind = PLE_ES[0];
  sel.value = PLE.ind.id;
  sel.addEventListener('change', function () {
    PLE.ind = pleInd(this.value) || PLE_ES[0];
    pleInfoUpdate(PLE.ind);
    if (PLE.active) pleDraw();
  });

  // Bascule quotidien / structurel
  var plv = document.getElementById('plView');
  plv.addEventListener('change', function () {
    PLE.view = this.value;
    pleShowView(this.value);
  });
}
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', pleInitUI);
}
