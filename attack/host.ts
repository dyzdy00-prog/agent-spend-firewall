import { hostOf } from "../src/policy.ts";
const cases = [
  "http://api.example.com/x", "http://API.Example.COM./x", "http://api.example.com../x", "http://api.example.com%2e/x",
  "http://api.example.com%2e%2e/x", "http://0x7f.1/", "http://2130706433/", "http://127.1:80/", "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/", "http://evil.com\\@api.example.com/", "http://evil.com#@api.example.com/", "http://api.example.com:0080/",
  "http://api.example.com:443/", "https://api.example.com:443/", "http://ａpi.example.com/", "http://api.exa%6dple.com/", "http://api.example.com\t/",
  "http://api.example.com。/", "http://api.example.com．/", "HTTP://API.example.com", "ftp://x/", "http://u@x.com/", "http://:@x.com/", "http://x.com:/", "http://xn--e1afmkfd.com/", "http://пример.com/",
  "http://x.com@evil.com/", "http:///x.com", "http:x.com", "http://[::1]:8080/", "http://a.com.:8443/",
];
for (const c of cases) console.log(JSON.stringify(c).padEnd(50), "=>", hostOf(c));
