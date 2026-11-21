#!/usr/bin/env python3
"""
SOTTOTITOLI LIVE per LiveGFX — 100% offline (riconoscimento vocale Vosk).

Ascolta il microfono, riconosce il parlato in italiano e manda le parole a
LiveGFX (che deve essere aperto sullo stesso Mac). La grafica è la fonte
"Sottotitoli" di LiveGFX; si accende, si mette in pausa e si regola dal pannello.

Uso (dal Terminale, dentro questa cartella):
  ./start.command                  avvia con il microfono predefinito del Mac
  ./start.command --microfoni      elenca i microfoni disponibili
  ./start.command --microfono 2    usa il microfono numero 2 dell'elenco
  ./start.command --demo           prova la grafica senza microfono

Tasti nel Terminale mentre gira:
  P = pausa / riprendi     C = svuota lo schermo     Q = esci
"""

import argparse
import array
import datetime
import json
import os
import queue
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request

# ----------------------------------------------------------------- impostazioni
CARTELLA = os.path.dirname(os.path.abspath(__file__))
CARTELLA_LIVEGFX = os.path.dirname(CARTELLA)
MICROFONO = None          # None = microfono predefinito; oppure il numero da --microfoni
CARTELLA_MODELLO = os.path.join(CARTELLA, "modello")
CARTELLA_TRASCRIZIONI = os.path.join(CARTELLA, "trascrizioni")
FILE_CORREZIONI = os.path.join(CARTELLA, "correzioni.txt")


# ------------------------------------------------- invio eventi a LiveGFX
def porta_livegfx():
    """Legge la porta da ../config.json di LiveGFX (di solito 3000)."""
    try:
        with open(os.path.join(CARTELLA_LIVEGFX, "config.json"), encoding="utf-8") as f:
            return int(json.load(f).get("port", 3000))
    except (OSError, ValueError):
        return 3000


class Invio:
    """Manda le parole a LiveGFX in un thread a parte, così il microfono non si blocca mai.
    Se arrivano tante parole parziali di fila, invia solo l'ultima (è quella che conta)."""

    def __init__(self, porta):
        self.url = f"http://127.0.0.1:{porta}/api/subs"
        self.coda = queue.Queue()
        self.collegato = None        # None = non ancora provato
        self.pausa_server = False    # stato "pausa" deciso dal pannello
        threading.Thread(target=self._ciclo, daemon=True).start()
        threading.Thread(target=self._battito, daemon=True).start()

    def invia(self, evento):
        self.coda.put(evento)

    def _post(self, evento):
        dati = json.dumps(evento, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.url, data=dati, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=2) as r:
                risposta = json.loads(r.read() or b"{}")
            self.pausa_server = bool(risposta.get("paused"))
            if self.collegato is not True:
                self.collegato = True
                TERM.riga(">> Collegato a LiveGFX.")
        except (urllib.error.URLError, OSError, ValueError):
            if self.collegato is not False:
                self.collegato = False
                TERM.riga(f">> LiveGFX non raggiungibile ({self.url}). Aprilo con il suo start.command: riprovo da solo.")

    def _ciclo(self):
        while True:
            evento = self.coda.get()
            # salta i parziali vecchi: se in coda c'è già qualcosa di più nuovo, invia quello
            while evento.get("tipo") == "parole" and not evento.get("finale") and not self.coda.empty():
                prossimo = self.coda.get()
                if prossimo.get("tipo") != "parole":
                    self._post(evento)
                evento = prossimo
            self._post(evento)

    def _battito(self):
        while True:
            self.invia({"tipo": "ping"})   # così il pannello sa che il programma è acceso
            time.sleep(2)


INVIO = None


# ------------------------------------------------------------------ correzioni
def carica_correzioni():
    """Legge correzioni.txt: righe 'sbagliato => giusto'. Riga vuota o con # = ignorata."""
    regole = []
    if not os.path.exists(FILE_CORREZIONI):
        return regole
    with open(FILE_CORREZIONI, encoding="utf-8") as f:
        for riga in f:
            riga = riga.strip()
            if not riga or riga.startswith("#") or "=>" not in riga:
                continue
            da, a = riga.split("=>", 1)
            da = da.strip()
            if da:
                regole.append((re.compile(r"\b" + re.escape(da) + r"\b", re.IGNORECASE), a.strip()))
    return regole


def correggi(testo, regole):
    for rx, sostituto in regole:
        testo = rx.sub(sostituto, testo)
    return " ".join(testo.split())


# ---------------------------------------------------------------- trascrizione
class Trascrizione:
    """File di testo con una frase per riga e l'orario di inizio: [10:42:15] ..."""

    def __init__(self):
        os.makedirs(CARTELLA_TRASCRIZIONI, exist_ok=True)
        adesso = datetime.datetime.now()
        nome = adesso.strftime("trascrizione_%Y-%m-%d_%H-%M.txt")
        self.percorso = os.path.join(CARTELLA_TRASCRIZIONI, nome)
        self.f = open(self.percorso, "a", encoding="utf-8")
        self.f.write(adesso.strftime("# Trascrizione del %d/%m/%Y, avvio alle %H:%M\n\n"))
        self.f.flush()

    def scrivi(self, inizio, testo):
        testo = testo[:1].upper() + testo[1:]
        self.f.write(f"[{inizio.strftime('%H:%M:%S')}] {testo}\n")
        self.f.flush()  # scritto subito su disco: se il Mac si spegne non si perde nulla

    def nota(self, messaggio):
        self.f.write(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] --- {messaggio} ---\n")
        self.f.flush()

    def chiudi(self):
        self.f.close()


# -------------------------------------------------------------- stato terminale
class Terminale:
    def __init__(self):
        self.ultimo = 0.0
        self.lock = threading.Lock()

    def riga(self, testo):
        """Stampa una riga fissa (frase completata, messaggi)."""
        with self.lock:
            sys.stdout.write("\r\033[K" + testo + "\n")
            sys.stdout.flush()

    def stato(self, livello, parziale, pausa, forza=False):
        """Riga che si aggiorna: livello microfono + testo che sta arrivando."""
        adesso = time.time()
        if not forza and adesso - self.ultimo < 0.1:
            return
        self.ultimo = adesso
        larghezza = shutil.get_terminal_size((100, 20)).columns
        barra = "#" * int(livello * 10)
        testa = "PAUSA" if pausa else "ASCOLTO"
        prefisso = f"[{barra:<10}] {testa} | "
        spazio = max(10, larghezza - len(prefisso) - 1)
        coda = parziale[-spazio:] if parziale else ""
        with self.lock:
            sys.stdout.write("\r\033[K" + prefisso + coda)
            sys.stdout.flush()


TERM = Terminale()


# ---------------------------------------------------------------------- motore
class Motore:
    """Riceve testo parziale/finale e lo manda alla pagina OBS e al file."""

    def __init__(self, trascrizione, regole):
        self.trascrizione = trascrizione
        self.regole = regole
        self.id_frase = 0
        self.inizio = None
        self.ultimo_parziale = ""
        self.pausa = False
        self.livello = 0.0

    def parziale(self, testo):
        testo = correggi(testo, self.regole)
        if not testo or testo == self.ultimo_parziale:
            return
        if self.inizio is None:
            self.inizio = datetime.datetime.now()
        self.ultimo_parziale = testo
        INVIO.invia({"tipo": "parole", "id": self.id_frase, "parole": testo.split(), "finale": False})
        TERM.stato(self.livello, testo, self.pausa)

    def finale(self, testo):
        testo = correggi(testo, self.regole)
        if testo:
            if self.inizio is None:
                self.inizio = datetime.datetime.now()
            INVIO.invia({"tipo": "parole", "id": self.id_frase, "parole": testo.split(), "finale": True})
            if self.trascrizione:
                self.trascrizione.scrivi(self.inizio, testo)
            TERM.riga(f"[{self.inizio.strftime('%H:%M:%S')}] {testo}")
        self.id_frase += 1
        self.inizio = None
        self.ultimo_parziale = ""

    def svuota(self):
        INVIO.invia({"tipo": "svuota"})


# ------------------------------------------------------------------ tastiera
def ascolta_tastiera(comandi):
    """Legge i tasti P / C / Q senza dover premere Invio."""
    if not sys.stdin.isatty():
        return
    import termios
    import tty
    fd = sys.stdin.fileno()
    vecchio = termios.tcgetattr(fd)

    def ripristina():
        termios.tcsetattr(fd, termios.TCSADRAIN, vecchio)

    import atexit
    atexit.register(ripristina)

    def ciclo():
        tty.setcbreak(fd)
        while True:
            tasto = sys.stdin.read(1).lower()
            if tasto in ("p", "c", "q"):
                comandi.put(tasto)
                if tasto == "q":
                    return

    threading.Thread(target=ciclo, daemon=True).start()


# ---------------------------------------------------------------- modalità demo
FRASI_DEMO = [
    "buongiorno a tutti e benvenuti all'assemblea d'istituto",
    "oggi parliamo delle proposte della rappresentanza per quest'anno",
    "prima di tutto vi ringraziamo per essere qui così numerosi",
    "alla fine ci sarà spazio per le vostre domande",
]


def esegui_demo(motore, comandi):
    TERM.riga("MODALITÀ DEMO: nessun microfono, frasi di prova in ciclo. Q per uscire.")
    i = 0
    while True:
        frase = FRASI_DEMO[i % len(FRASI_DEMO)].split()
        for n in range(1, len(frase) + 1):
            if gestisci_comandi(motore, comandi, None):
                return
            while motore.pausa:
                if gestisci_comandi(motore, comandi, None):
                    return
                time.sleep(0.1)
            motore.livello = 0.6
            motore.parziale(" ".join(frase[:n]))
            time.sleep(0.3)
        motore.finale(" ".join(frase))
        time.sleep(1.5)
        i += 1


# -------------------------------------------------------------- comandi P/C/Q
def imposta_pausa(motore, rec, pausa):
    """Entra o esce dalla pausa (chiamata dal tasto P o dal pulsante nel pannello)."""
    if pausa == motore.pausa:
        return
    if pausa:
        if rec is not None:
            motore.finale(json.loads(rec.FinalResult()).get("text", ""))
            rec.Reset()
        motore.pausa = True
        motore.svuota()
        if motore.trascrizione:
            motore.trascrizione.nota("pausa")
        TERM.riga(">> PAUSA (sottotitoli fermi, niente trascrizione). P o il pannello per riprendere.")
    else:
        motore.pausa = False
        if motore.trascrizione:
            motore.trascrizione.nota("ripresa")
        TERM.riga(">> RIPRESA.")


def gestisci_comandi(motore, comandi, rec):
    """Ritorna True se bisogna uscire."""
    # la pausa decisa dal pannello di LiveGFX vale anche qui
    if INVIO.collegato and INVIO.pausa_server != motore.pausa:
        imposta_pausa(motore, rec, INVIO.pausa_server)
    while True:
        try:
            tasto = comandi.get_nowait()
        except queue.Empty:
            return False
        if tasto == "q":
            return True
        if tasto == "p":
            nuova = not motore.pausa
            imposta_pausa(motore, rec, nuova)
            INVIO.invia({"tipo": "pausa" if nuova else "riprendi"})
            INVIO.pausa_server = nuova   # evita che il prossimo controllo la annulli prima della risposta
        if tasto == "c":
            if rec is not None:
                motore.finale(json.loads(rec.FinalResult()).get("text", ""))
                rec.Reset()
            motore.svuota()
            TERM.riga(">> Schermo svuotato.")


# ---------------------------------------------------------------- microfono reale
def esegui_microfono(motore, comandi, microfono):
    import sounddevice as sd
    import vosk

    if not os.path.isdir(CARTELLA_MODELLO):
        print("\n[ERRORE] Cartella 'modello' non trovata. Avvia con start.command (la scarica da solo).")
        return
    vosk.SetLogLevel(-1)
    print("Carico il modello...", flush=True)
    modello = vosk.Model(CARTELLA_MODELLO)

    info = sd.query_devices(microfono, "input")
    freq = int(info["default_samplerate"])
    rec = vosk.KaldiRecognizer(modello, freq)
    audio = queue.Queue()

    def callback(dati, frames, tempo, stato):
        audio.put(bytes(dati))

    print(f"Microfono: {info['name']}  ({freq} Hz)")
    with sd.RawInputStream(samplerate=freq, blocksize=freq // 8, device=microfono,
                           dtype="int16", channels=1, callback=callback):
        TERM.riga("Pronto. Parla nel microfono.  P = pausa  C = svuota  Q = esci")
        while True:
            if gestisci_comandi(motore, comandi, rec):
                motore.finale(json.loads(rec.FinalResult()).get("text", ""))
                return
            try:
                blocco = audio.get(timeout=0.2)
            except queue.Empty:
                continue
            campioni = array.array("h", blocco)
            if campioni:
                picco = max(max(campioni), -min(campioni))
                motore.livello = min(1.0, picco / 20000)
            if motore.pausa:
                TERM.stato(motore.livello, "", True)
                continue
            if rec.AcceptWaveform(blocco):
                motore.finale(json.loads(rec.Result()).get("text", ""))
            else:
                motore.parziale(json.loads(rec.PartialResult()).get("partial", ""))
            TERM.stato(motore.livello, motore.ultimo_parziale, False)


def elenca_microfoni():
    import sounddevice as sd
    predefinito = sd.default.device[0]
    print("\nMicrofoni disponibili:")
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0:
            segno = "  <- predefinito" if i == predefinito else ""
            print(f"  {i}: {d['name']}{segno}")
    print("\nPer usarne uno:  ./start.command --microfono NUMERO\n")


# -------------------------------------------------------------------------- main
def main():
    parser = argparse.ArgumentParser(description="Sottotitoli live per OBS (offline)")
    parser.add_argument("--microfoni", action="store_true", help="elenca i microfoni")
    parser.add_argument("--microfono", type=int, default=MICROFONO, help="numero del microfono")
    parser.add_argument("--demo", action="store_true", help="frasi di prova, senza microfono")
    args = parser.parse_args()

    if args.microfoni:
        elenca_microfoni()
        return

    global INVIO
    porta = porta_livegfx()
    print("\n=== SOTTOTITOLI LIVE per LiveGFX ===")
    print(f"Invio a LiveGFX su http://localhost:{porta}")
    print("In OBS la grafica è già nell'overlay di LiveGFX (o da sola: /gfx/subtitles.html).")
    print("Accendila dal pannello: scheda Sottotitoli -> VAI IN ONDA.")
    INVIO = Invio(porta)

    regole = carica_correzioni()
    if regole:
        print(f"Correzioni caricate: {len(regole)}")

    trascrizione = None if args.demo else Trascrizione()
    if trascrizione:
        print(f"Trascrizione: {trascrizione.percorso}")

    motore = Motore(trascrizione, regole)
    comandi = queue.Queue()
    ascolta_tastiera(comandi)

    try:
        if args.demo:
            esegui_demo(motore, comandi)
        else:
            esegui_microfono(motore, comandi, args.microfono)
    except KeyboardInterrupt:
        pass
    finally:
        motore.svuota()
        time.sleep(0.3)   # lascia partire l'ultimo invio
        if trascrizione:
            trascrizione.chiudi()
            print(f"\n\nTrascrizione salvata in:\n{trascrizione.percorso}")
        print("\nChiuso.")


if __name__ == "__main__":
    main()
