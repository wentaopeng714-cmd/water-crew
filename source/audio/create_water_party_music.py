"""Original sixteen-bar island-party score; deterministic local synthesis, no samples."""
from pathlib import Path
import numpy as np
import wave, subprocess, base64, json, re, shutil

ROOT = Path(__file__).resolve().parents[2]
IS_WORKSPACE = (ROOT / 'outputs/water-game-design').is_dir()
OUT = ROOT / ('outputs/water-game-design/audio' if IS_WORKSPACE else 'audio')
WORK = ROOT / ('work/audio' if IS_WORKSPACE else 'source/audio')
MODULE = ROOT / ('work/game-audio.js' if IS_WORKSPACE else 'game-audio.js')
SR = 44100
BPM = 108
BEAT = 60 / BPM
BAR = BEAT * 4
LENGTH = BAR * 16
N = round(SR * LENGTH)
rng = np.random.default_rng(271828)
mix = np.zeros((N, 2), np.float64)

def midi(note):
    names={'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}
    return 12*(int(note[-1])+1)+names[note[0]]+(1 if '#' in note else 0)

def freq(note): return 440*2**((midi(note)-69)/12)

def add(w, start, amp=1, pan=0):
    # Wrap note/reverb tails over the loop boundary instead of chopping them.
    ids=(round(start*SR)+np.arange(len(w)))%N
    stereo=np.array([np.cos((pan+1)*np.pi/4),np.sin((pan+1)*np.pi/4)])
    for c in range(2): np.add.at(mix[:,c],ids,w*amp*stereo[c])

def tone(note, dur, kind):
    t=np.arange(round(SR*dur))/SR; f=freq(note)
    attack=1-np.exp(-t*700)
    if kind=='marimba':
        w=(np.sin(2*np.pi*f*t)*np.exp(-t/0.42)
           +.20*np.sin(2*np.pi*f*3.99*t)*np.exp(-t/.075)
           +.065*np.sin(2*np.pi*f*9.98*t)*np.exp(-t/.025))
        w*=attack
    elif kind=='steel':
        w=(np.sin(2*np.pi*f*t)*np.exp(-t/.64)
           +.27*np.sin(2*np.pi*f*2*t)*np.exp(-t/.32)
           +.08*np.sin(2*np.pi*f*2.78*t)*np.exp(-t/.12))*attack
    elif kind=='pluck':
        w=np.zeros(len(t))
        for h in range(1,8):
            w+=np.sin(2*np.pi*f*h*t+.12*h)*np.exp(-t/(.29/(h**.55)))/(h**1.55)
        w*=attack
    elif kind=='bass':
        w=(np.sin(2*np.pi*f*t)+.14*np.sin(2*np.pi*f*2*t))
        w*=np.minimum(1,t/.012)*np.exp(-t/.36)
    w*=np.minimum(1,(dur-t)/.03)
    return w

chords=[['C4','E4','G4','C5'],['A3','C4','E4','A4'],['F3','A3','C4','F4'],['G3','B3','D4','G4'],
        ['C4','E4','G4','C5'],['A3','C4','E4','A4'],['F3','A3','C4','F4'],['G3','B3','D4','G4'],
        ['D4','F4','A4','D5'],['G3','B3','D4','G4'],['E3','G3','B3','E4'],['A3','C4','E4','A4'],
        ['F3','A3','C4','F4'],['G3','B3','D4','G4'],['C4','E4','G4','C5'],['G3','B3','D4','G4']]
basses=['C2','A2','F2','G2','C2','A2','F2','G2','D2','G2','E2','A2','F2','G2','C2','G2']
fifths=['G2','E3','C3','D3','G2','E3','C3','D3','A2','D3','B2','E3','C3','D3','G2','D3']
melodies=[
 [('C5',0),('E5',.75),('G5',1.5),('A5',2.5),('G5',3.25)],
 [('E5',0),('D5',.75),('C5',1.5),('E5',3),('G5',3.5)],
 [('A5',0),('G5',.75),('F5',1.5),('E5',2.5),('C5',3.25)],
 [('D5',0),('E5',.5),('G5',1.5),('D5',2.75),('B4',3.5)],
 [('C5',0),('E5',.75),('G5',1.5),('C6',2.5),('B5',3.25)],
 [('A5',0),('G5',.75),('E5',1.5),('G5',2.5),('E5',3.25)],
 [('F5',0),('A5',.75),('G5',1.5),('F5',2.5),('E5',3.25)],
 [('D5',0),('G5',1),('B5',2),('G5',2.75),('E5',3.5)],
 [('F5',0),('A5',.5),('D6',1.5),('C6',2.5),('A5',3.25)],
 [('B5',0),('A5',.75),('G5',1.5),('D5',2.5),('G5',3.25)],
 [('E5',0),('G5',.75),('B5',1.5),('G5',2.5),('E5',3.25)],
 [('A5',0),('C6',.75),('B5',1.5),('A5',2.5),('E5',3.25)],
 [('F5',0),('A5',.75),('C6',1.5),('A5',2.5),('G5',3.25)],
 [('G5',0),('B5',.5),('D6',1.5),('B5',2.5),('G5',3.25)],
 [('C6',0),('G5',1),('E5',2),('D5',2.75),('C5',3.5)],
 [('B4',0),('D5',.75),('G5',1.5),('E5',2.5),('D5',3.25)]
]

for bar in range(16):
    st=bar*BAR
    for note,pos in melodies[bar]:
        add(tone(note,1.05,'marimba'),st+pos*BEAT,.23,-.14)
        if bar>=8: add(tone(note,.9,'steel'),st+pos*BEAT+.007,.055,.28)
    for pos,level in [(0,.07),(1.5,.095),(2.5,.075),(3.5,.09)]:
        for j,note in enumerate(chords[bar]):
            add(tone(note,.8,'pluck'),st+pos*BEAT+j*.008,level,.36)
    for pos,note,level in [(0,basses[bar],.25),(1.5,fifths[bar],.17),(2,basses[bar],.23),(3.25,fifths[bar],.16)]:
        add(tone(note,.7,'bass'),st+pos*BEAT,level,-.04)
    for pos in [0,2]:
        t=np.arange(round(SR*.28))/SR
        kick=np.sin(2*np.pi*(49*t+5*(1-np.exp(-t*30))))*np.exp(-t*18)
        add(kick,st+pos*BEAT,.18,0)
    for pos in [1,3]:
        t=np.arange(round(SR*.14))/SR
        noise=rng.normal(0,1,len(t)); noise=np.convolve(noise,np.ones(5)/5,'same')
        conga=(np.sin(2*np.pi*(170*t+2*(1-np.exp(-t*60))))*.65+noise*.27)*np.exp(-t*37)
        add(conga,st+pos*BEAT,.12,-.30)
    for off in range(8):
        t=np.arange(round(SR*.06))/SR
        ns=rng.normal(0,1,len(t)); ns=ns-np.convolve(ns,np.ones(9)/9,'same')
        shaker=ns*np.minimum(1,t/.006)*np.exp(-t*90)
        add(shaker,st+(off*.5+(0.035 if off%2 else 0))*BEAT,.025 if off%2 else .035,.50)
    # A soft offbeat rim gives the second phrase a lift without louder melody.
    if bar>=8:
        for pos in [.5,2.5]:
            t=np.arange(round(SR*.08))/SR
            rim=(np.sin(2*np.pi*920*t)+.25*np.sin(2*np.pi*1430*t))*np.exp(-t*95)
            add(rim,st+pos*BEAT,.03,-.45)

dry=mix.copy()
for delay,level in [(.073,.11),(.131,.09),(.197,.07),(.281,.05),(.397,.035)]:
    # Small room reflections; channel exchange adds space, keeps the bass central.
    mix += np.roll(dry[:,::-1],round(delay*SR),axis=0)*level
mix=np.tanh(mix*1.16)
mix*=.88/max(np.max(np.abs(mix)),.88)
OUT.mkdir(parents=True,exist_ok=True)
WORK.mkdir(parents=True,exist_ok=True)
wav_path=WORK/'water_party_v5.wav'
with wave.open(str(wav_path),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR)
    w.writeframes((mix*32767).astype('<i2').tobytes())
mp3_path=OUT/'water-party-original-v5.mp3'
ffmpeg=shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-y','-i',str(wav_path),
                '-codec:a','libmp3lame','-b:a','128k','-metadata','title=Water Party / Fountain Days',
                '-metadata','artist=Original local game score',str(mp3_path)],check=True)
encoded=base64.b64encode(mp3_path.read_bytes()).decode('ascii')
uri='data:audio/mpeg;base64,'+encoded
(WORK/'music-data-uri.txt').write_text(uri)
if MODULE.exists():
    source=MODULE.read_text()
    source=re.sub(r'^export const BUILTIN_MUSIC_DATA_URI = .*;$',lambda _: 'export const BUILTIN_MUSIC_DATA_URI = '+repr(uri)+';',source,flags=re.M)
    MODULE.write_text(source)
metadata={'title':'喷泉假日 / Fountain Days','composer':'本项目原创程序作曲与合成','bpm':BPM,'bars':16,
          'durationSeconds':N/SR,'key':'C major','form':'8-bar A + 8-bar B',
          'instruments':['marimba','steel-pan accent','plucked four-note chords','bass','soft kick','hand drum','shaker'],
          'externalSamples':False,'peak':float(np.max(np.abs(mix))),'rms':float(np.sqrt(np.mean(mix**2)))}
(OUT/'music-notes.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(metadata,ensure_ascii=False));print('MP3 bytes',mp3_path.stat().st_size)
