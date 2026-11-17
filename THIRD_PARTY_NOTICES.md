# Componenti di terze parti

Il codice di LiveGFX è distribuito con licenza MIT (vedi `LICENSE`).
Il progetto include o scarica questi componenti, ognuno con la **propria** licenza:

| Componente | Dove | Licenza |
|---|---|---|
| GSAP e Flip (GreenSock) | `public/vendor/gsap.min.js`, `public/vendor/Flip.min.js` | Licenza standard "No Charge" di GSAP (gratuita anche per uso commerciale, **non** open source in senso OSI): https://gsap.com/standard-license |
| qrcode-generator (Kazuhiko Arase) | `public/vendor/qrcode.js` | MIT |
| Inter, Chakra Petch, Playfair Display, Press Start 2P, VT323 | `public/vendor/fonts/` | SIL Open Font License 1.1 (testi completi nella stessa cartella) |
| ws | dipendenza npm (`node_modules/`, non inclusa nel repository) | MIT |
| Vosk e modello italiano | scaricati da `sottotitoli/start.command` al primo avvio | Apache 2.0 |
| sounddevice | scaricato da `sottotitoli/start.command` | MIT |
| cloudflared | scaricato in `bin/` al primo voto online | Apache 2.0 |

La licenza MIT di LiveGFX non si applica a questi file: chi riusa il progetto deve rispettare le licenze originali.
