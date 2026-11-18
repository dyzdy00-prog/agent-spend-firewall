// Real run recorded 2026-11-18 on Base Sepolia by driving the firewall call by call (frames f00..f15.jpg).
window.ASFRun = {
 "date": "2026-11-18",
 "network": "eip155:84532",
 "payer": "0xebf7bD06545D1782C8aF8be0DEFc8Ab53D215119",
 "payee": "0xe4234e9b2c6CfBE4Ae4fE8f0c927E046cb5F945A",
 "lines": [
  {
   "ms": 1333,
   "path": "/good",
   "kind": "ok",
   "usd6": "10000",
   "tx": "0xb49c8540f81f697213d5e0b9bd72b9d69d97e42671afadb87dbe4d4ca2879006",
   "status": 200
  },
  {
   "ms": 2619,
   "path": "/good",
   "kind": "ok",
   "usd6": "10000",
   "tx": null,
   "status": 402
  },
  {
   "ms": 3179,
   "path": "/pricey",
   "kind": "no",
   "code": "CAP",
   "reason": "payment exceeds per-payment cap"
  },
  {
   "ms": 4443,
   "path": "/switch",
   "kind": "ok",
   "usd6": "10000",
   "tx": null,
   "status": 402
  },
  {
   "ms": 4978,
   "path": "/switch-b",
   "kind": "no",
   "code": "PAYEE",
   "reason": "payee differs from the one first paid on this host"
  },
  {
   "ms": 5805,
   "path": "/nodeliver",
   "kind": "ok",
   "usd6": "10000",
   "tx": null,
   "status": 500
  },
  {
   "ms": 6697,
   "path": "/nodeliver",
   "kind": "ok",
   "usd6": "10000",
   "tx": null,
   "status": 500
  },
  {
   "ms": 7195,
   "path": "/nodeliver",
   "kind": "no",
   "code": "UNDELIVERED",
   "reason": "host blocked after undelivered paid requests"
  },
  {
   "ms": 7639,
   "path": "169.254.169.254",
   "kind": "no",
   "code": "HOST",
   "reason": "private or internal address"
  },
  {
   "ms": 9168,
   "path": "/good",
   "kind": "ok",
   "usd6": "10000",
   "tx": "0x691e8e41e4e603c6d48b18ab076e1d45e61fb3a667c94846e6e086be34489889",
   "status": 200
  },
  {
   "ms": 10402,
   "path": "/good",
   "kind": "ok",
   "usd6": "10000",
   "tx": "0x3f344e7e5e01d85a425863e4713a56d7695e658067b29dcd255b294192711b7a",
   "status": 200
  },
  {
   "ms": 11924,
   "path": "/good",
   "kind": "ok",
   "usd6": "10000",
   "tx": "0x95027623e1c9bd3bfe7fcc025c0fae69bc7672deed12d14415a53fe4cb67cd5e",
   "status": 200
  },
  {
   "ms": 13813,
   "path": "/good",
   "kind": "ok",
   "usd6": "10000",
   "tx": "0xa89dd34e8241d456707d8fa7b4889d3a95d5ca35023c2079f950d1b5b5218d23",
   "status": 200
  },
  {
   "ms": 15332,
   "path": "/good",
   "kind": "ok",
   "usd6": "10000",
   "tx": "0x65ccf68255daed8910d00b78cb73c68e4149c5b7c6359b812a20811e8580d7da",
   "status": 200
  },
  {
   "ms": 15900,
   "path": "/good",
   "kind": "no",
   "code": "BUDGET",
   "reason": "global budget exceeded"
  }
 ]
};
