/* Общая логика «Мой участковый»: работает и в браузере (Mini App), и в Node.js (бот). */
(function (root) {
  var D = root.DATA || (typeof require !== "undefined" ? require("./data.js") : null);

  var norm = function (s) {
    return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[«»"]/g, "").replace(/\s+/g, " ").trim();
  };
  var TYPE_WORDS = /(^|\s)(ул|улица|пр-кт|проспект|пр|пер|переулок|мкр|микрорайон|кв-л|квартал|ш|шоссе|тракт|тер|проезд|пл|площадь|д|дом|г|город|якутск)\.?(?=\s|,|$)/g;
  var normStreet = function (s) {
    return norm(s).replace(/\(.*?\)/g, " ").replace(/[.,]/g, " ").replace(TYPE_WORDS, " ").replace(TYPE_WORDS, " ").replace(/\s+/g, " ").trim();
  };
  var normHouse = function (h) {
    return norm(h).replace(/\(.*?\)/g, "").replace(/a/g, "а").replace(/b/g, "б").replace(/c/g, "с")
      .replace(/\s*(корпус|корп\.?|к\.?)\s*/g, "к").replace(/\s*(строение|стр\.?|ст\.)\s*/g, "с").replace(/\s+/g, "");
  };

  /* ---------- индекс улиц ---------- */
  var streets = {}; // key -> {label, items:[{o, loc}]}
  D.officers.forEach(function (o, idx) {
    o.id = idx;
    o.l.forEach(function (l) {
      var label = l.st ? l.st + (l.t ? " " + l.t + (/[а-я]$/.test(l.t) && l.t.length <= 3 ? "." : "") : "") : l.s;
      if (l.st && l.s !== "Якутск") label += " (" + l.s + ")";
      var key = normStreet(l.st || l.s);
      if (!key) return;
      if (!streets[key]) streets[key] = { key: key, label: label, items: [] };
      streets[key].items.push({ o: o, h: l.h.map(normHouse) });
    });
  });
  var streetList = Object.keys(streets).map(function (k) { return streets[k]; })
    .sort(function (a, b) { return a.label.localeCompare(b.label, "ru"); });

  function lev(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) d[i] = [i];
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }

  var SETTLEMENTS = {};
  D.officers.forEach(function (o) { o.l.forEach(function (l) { if (l.s !== "Якутск" && l.st) SETTLEMENTS[norm(l.s)] = 1; }); });
  SETTLEMENTS["марха"] = 1;
  function parseQuery(q) {
    var s = norm(q).replace(/,/g, " ");
    var words = s.split(" ");
    if (words.length > 1 && SETTLEMENTS[words[0]]) s = words.slice(1).join(" ");
    var m = s.match(/\s(\d+[а-яa-z]?(?:\s*\/\s*\d+[а-яa-z]?)?(?:\s*(?:к|корп|корпус)\.?\s*\d+[а-я]?)?(?:\s*(?:стр|с)\.?\s*\d+)?)\s*$/);
    var house = m ? m[1] : "";
    var street = normStreet(m ? s.slice(0, m.index) : s);
    return { street: street, house: house ? normHouse(house) : "" };
  }

  function matchStreets(sq) {
    if (!sq) return [];
    if (streets[sq]) return [streets[sq]];
    var starts = streetList.filter(function (x) {
      return x.key.indexOf(sq) === 0 || x.key.split(" ").some(function (w) { return w.indexOf(sq) === 0; });
    });
    if (starts.length) return starts;
    if (sq.length >= 4) {
      var tol = sq.length >= 7 ? 2 : 1;
      return streetList.filter(function (x) {
        return x.key.split(" ").some(function (w) { return lev(w.slice(0, sq.length + 1), sq) <= tol; }) || lev(x.key, sq) <= tol;
      });
    }
    return [];
  }

  /* Поиск: «Горького 94», «ул. Ильменская, д. 57 к 2», «Маган» */
  function find(q) {
    var p = parseQuery(q), list = matchStreets(p.street);
    var exact = [], onStreet = [], seen = {};
    list.forEach(function (st) {
      st.items.forEach(function (it) {
        var hit = !it.h.length || (p.house && it.h.indexOf(p.house) >= 0);
        var arr = hit && (p.house || !it.h.length) ? exact : onStreet;
        if (!seen[it.o.id + (arr === exact ? "e" : "s")]) { seen[it.o.id + (arr === exact ? "e" : "s")] = 1; arr.push(it.o); }
      });
    });
    onStreet = onStreet.filter(function (o) { return exact.indexOf(o) < 0; });
    return { query: p, streets: list, exact: exact, onStreet: onStreet };
  }

  function suggest(q, n) {
    var p = parseQuery(q);
    return matchStreets(p.street).slice(0, n || 6).map(function (x) { return x.label; });
  }

  /* ---------- расписание ---------- */
  var STEMS = ["воскр", "понед", "вторн", "сред", "четв", "пятн", "суббот"];
  function slots(hr) {
    var t = norm(hr), re = /с\s*(\d{1,2})[:.](\d{2})\s*(?:ч\w*\.?)?\s*до\s*(\d{1,2})[:.](\d{2})/g, last = 0, out = [], m;
    while ((m = re.exec(t))) {
      var seg = t.slice(last, m.index), tail = t.slice(m.index, m.index + 70);
      var p2 = function (x) { return (x.length < 2 ? "0" : "") + x; };
      STEMS.forEach(function (st, d) {
        if (seg.indexOf(st) < 0) return;
        out.push({ d: d, from: p2(m[1]) + ":" + m[2], to: p2(m[3]) + ":" + m[4],
          first: d === 6 && /перв\S*\s*суббот/.test(seg),
          monthly: d === 6 && /раз в месяц/.test(tail) });
      });
      last = re.lastIndex;
    }
    return out;
  }
  /* Ближайший приём по якутскому времени (UTC+9) */
  function nextSlot(hr, nowMs) {
    var S = slots(hr).filter(function (s) { return !s.monthly; });
    if (!S.length) return null;
    var now = new Date((nowMs || Date.now()) + 9 * 3600e3);
    for (var k = 0; k < 40; k++) {
      var day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + k));
      var wd = day.getUTCDay();
      var c = S.filter(function (s) { return s.d === wd && (!s.first || day.getUTCDate() <= 7); })
        .sort(function (a, b) { return a.from < b.from ? -1 : 1; });
      for (var j = 0; j < c.length; j++) {
        if (k === 0) {
          var endMin = +c[j].to.slice(0, 2) * 60 + +c[j].to.slice(3);
          if (now.getUTCHours() * 60 + now.getUTCMinutes() >= endMin) continue;
        }
        var startMin = +c[j].from.slice(0, 2) * 60 + +c[j].from.slice(3);
        var nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
        return { days: k, date: day, from: c[j].from, to: c[j].to, live: k === 0 && nowMin >= startMin };
      }
    }
    return null;
  }

  /* ---------- ближайшие пункты ---------- */
  function dist(a, b, c, d) {
    var R = 6371, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
    var h = Math.sin(x / 2) * Math.sin(x / 2) + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) * Math.sin(y / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function nearest(lat, lng, n) {
    return D.points.map(function (p) { return { p: p, km: dist(lat, lng, p.lat, p.lng) }; })
      .sort(function (a, b) { return a.km - b.km; }).slice(0, n || 3);
  }
  function officersAt(pointId) { return D.officers.filter(function (o) { return o.p === pointId; }); }

  var API = { DATA: D, find: find, suggest: suggest, slots: slots, nextSlot: nextSlot, nearest: nearest,
    officersAt: officersAt, streets: streetList, parseQuery: parseQuery };
  if (typeof module !== "undefined") module.exports = API; else root.Core = API;
})(this);
