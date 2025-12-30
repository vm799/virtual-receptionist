
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SYSTEM_PROMPT } from './constants';
import { decode, decodeAudioData, createBlob } from './utils/audio-utils';

type Tab = 'concierge' | 'examinations' | 'atelier' | 'health' | 'contact';

interface TranscriptionEntry {
  text: string;
  sender: 'user' | 'agent';
  timestamp: Date;
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('concierge');
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [currentOutput, setCurrentOutput] = useState('');
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const inputTranscriptionRef = useRef('');
  const outputTranscriptionRef = useRef('');

  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [transcriptions, currentInput, currentOutput]);

  const stopCall = useCallback(() => {
    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (audioContextInRef.current) { audioContextInRef.current.close(); audioContextInRef.current = null; }
    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    activeSourcesRef.current.clear();
    setIsActive(false);
    setIsConnecting(false);
    setIsAgentSpeaking(false);
    nextStartTimeRef.current = 0;
    inputTranscriptionRef.current = '';
    outputTranscriptionRef.current = '';
  }, []);

  const startCall = async () => {
    try {
      setIsConnecting(true);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sampleRateIn = 16000;
      const sampleRateOut = 24000;

      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: sampleRateIn });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: sampleRateOut });
      await audioContextInRef.current.resume();
      await audioContextOutRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: SYSTEM_PROMPT,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsActive(true);
            setIsConnecting(false);
            sessionPromise.then((session) => {
              sessionRef.current = session;
              session.sendRealtimeInput({ text: "START_CALL" });
            });

            const source = audioContextInRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.outputTranscription) {
              outputTranscriptionRef.current += msg.serverContent.outputTranscription.text;
              setCurrentOutput(outputTranscriptionRef.current);
              setIsAgentSpeaking(true);
            } else if (msg.serverContent?.inputTranscription) {
              inputTranscriptionRef.current += msg.serverContent.inputTranscription.text;
              setCurrentInput(inputTranscriptionRef.current);
            }
            if (msg.serverContent?.turnComplete) {
              const userText = inputTranscriptionRef.current;
              const agentText = outputTranscriptionRef.current;
              setTranscriptions(prev => {
                const newEntries: TranscriptionEntry[] = [
                  { text: userText, sender: 'user' as const, timestamp: new Date() },
                  { text: agentText, sender: 'agent' as const, timestamp: new Date() }
                ];
                return [...prev, ...newEntries].filter(t => t.text.trim() !== '' && t.text !== "START_CALL");
              });
              inputTranscriptionRef.current = ''; outputTranscriptionRef.current = '';
              setCurrentInput(''); setCurrentOutput(''); setIsAgentSpeaking(false);
            }
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, sampleRateOut, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.addEventListener('ended', () => {
                activeSourcesRef.current.delete(source);
                if (activeSourcesRef.current.size === 0) setIsAgentSpeaking(false);
              });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSourcesRef.current.add(source);
              setIsAgentSpeaking(true);
            }
            if (msg.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAgentSpeaking(false);
            }
          },
          onerror: (e) => { console.error(e); stopCall(); },
          onclose: () => stopCall(),
        }
      });
    } catch (err) { console.error(err); setIsConnecting(false); stopCall(); }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'examinations':
        return (
          <div className="animate-fadeIn space-y-12 p-8 md:p-16 max-w-5xl mx-auto flex flex-col items-center text-center">
            <div className="space-y-4">
              <span className="text-[#c5a059] font-black text-[10px] tracking-[0.5em] uppercase">Visual Excellence</span>
              <h2 className="font-serif text-5xl text-[#1e1b4b]">The Bespoke Examination</h2>
            </div>
            <div className="grid md:grid-cols-2 gap-12 text-left">
              <div className="space-y-6 bg-white p-10 rounded-3xl border border-slate-100 shadow-sm">
                <h3 className="font-bold text-xs tracking-widest text-[#1e1b4b] uppercase border-b border-slate-100 pb-3">ADVANCED IMAGING</h3>
                <p className="text-slate-600 leading-relaxed text-sm font-medium">As part of our commitment to preventative care, our examinations include 3D Optical Coherence Tomography. This captures high-resolution imagery of the retina, allowing for the early detection of pathology long before symptoms arise.</p>
              </div>
              <div className="space-y-6 bg-white p-10 rounded-3xl border border-slate-100 shadow-sm">
                <h3 className="font-bold text-xs tracking-widest text-[#1e1b4b] uppercase border-b border-slate-100 pb-3">DEDICATED TIME</h3>
                <p className="text-slate-600 leading-relaxed text-sm font-medium">We allocate a minimum of 40 minutes for every private consultation. This unhurried approach ensures our optometrists can thoroughly discuss your visual health and specific lifestyle requirements.</p>
              </div>
            </div>
          </div>
        );
      case 'atelier':
        return (
          <div className="animate-fadeIn space-y-16 p-8 md:p-16 max-w-6xl mx-auto flex flex-col items-center">
             <div className="text-center space-y-6">
               <span className="text-[#c5a059] font-black text-[10px] tracking-[0.5em] uppercase">The Collection</span>
               <h2 className="font-serif text-6xl text-[#1e1b4b]">The Frame Atelier</h2>
               <p className="text-slate-500 max-w-2xl mx-auto text-sm leading-relaxed font-medium">A meticulously curated selection of independent eyewear, where artisanal craftsmanship meets sophisticated design.</p>
             </div>
             <div className="grid md:grid-cols-3 gap-8 w-full">
                <BrandCard name="Lindberg" origin="DENMARK" desc="Minimalist titanium frames. No screws, no rivets, simply sophisticated." />
                <BrandCard name="Theo" origin="BELGIUM" desc="Experimental, colorful, and bold architectural art for the face." />
                <BrandCard name="Anne et Valentin" origin="FRANCE" desc="Geometric precision and eclectic flair for unique facial structures." />
             </div>
          </div>
        );
      case 'health':
        return (
          <div className="animate-fadeIn p-8 md:p-16 max-w-5xl mx-auto space-y-16 flex flex-col items-center text-center">
            <div className="space-y-4">
              <span className="text-[#c5a059] font-black text-[10px] tracking-[0.5em] uppercase">Specialized Care</span>
              <h2 className="font-serif text-5xl text-[#1e1b4b]">Practice Services</h2>
            </div>
            <div className="space-y-4 w-full text-left">
              <HealthService title="Myopia Management" desc="Dedicated protocols to slow short-sightedness in children." />
              <HealthService title="Dry Eye Diagnostic Centre" desc="Precision therapeutic management for ocular discomfort." />
              <HealthService title="Diagnostic Monitoring" desc="Advanced tracking for conditions like Glaucoma." />
            </div>
          </div>
        );
      case 'contact':
        return (
          <div className="animate-fadeIn p-8 md:p-16 max-w-4xl mx-auto flex flex-col items-center">
             <div className="bg-[#1e1b4b] p-16 rounded-[3rem] text-white space-y-10 text-center shadow-2xl">
               <span className="text-[#c5a059] font-black text-[10px] tracking-[0.5em] uppercase">Visual Freedom</span>
               <h2 className="font-serif text-5xl">Precision Contact Lenses</h2>
               <p className="text-indigo-100/70 leading-relaxed font-medium max-w-xl mx-auto text-sm">Daily disposables and multifocal solutions with expert boutique fitting.</p>
               <div className="flex justify-center gap-6 pt-4">
                  <span className="border border-white/20 px-6 py-2 rounded-full text-[9px] font-black tracking-widest uppercase">Health Check</span>
                  <span className="border border-white/20 px-6 py-2 rounded-full text-[9px] font-black tracking-widest uppercase">Digital Care</span>
                  <span className="border border-white/20 px-6 py-2 rounded-full text-[9px] font-black tracking-widest uppercase">Monthly Plan</span>
               </div>
             </div>
          </div>
        );
      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center animate-fadeIn min-h-[70vh]">
            {!isActive && !isConnecting ? (
              <div className="max-w-7xl mx-auto w-full flex flex-col md:flex-row items-center justify-between gap-16 px-4 md:px-12">
                <div className="md:w-3/5 text-center md:text-left space-y-8">
                  <div className="space-y-6">
                    <span className="text-[#c5a059] font-black text-[10px] tracking-[0.5em] uppercase">Where tradition meets technology</span>
                    <h2 className="text-5xl md:text-7xl font-serif text-[#1e1b4b] font-bold leading-[1.1]">Optical concierge at your service <br/><span className="italic font-normal text-slate-400">24 hours, 7 days a week.</span></h2>
                    <p className="text-slate-400 max-w-xl md:mx-0 mx-auto font-medium text-lg leading-relaxed">Experience sophisticated optical concierge assistance. Boutique standards, optical guidance, available whenever you require.</p>
                  </div>
                </div>

                <div className="md:w-2/5 flex justify-center md:justify-end">
                  <button 
                    onClick={startCall}
                    className="group relative flex flex-col items-center gap-8 bg-[#1e1b4b] text-white px-16 py-14 rounded-[3rem] transition-all hover:shadow-2xl hover:scale-[1.02] active:scale-95 border border-indigo-900/20 shadow-xl"
                  >
                    <div className="p-1 bg-[#c5a059]/30 rounded-full">
                      <div className="p-6 bg-[#c5a059] rounded-full shadow-inner group-hover:scale-110 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" strokeWidth={1} /></svg>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <span className="text-xl font-bold tracking-tight block">Initiate Concierge</span>
                      <span className="text-[9px] text-[#c5a059] font-black uppercase tracking-[0.3em]">Encrypted Connection</span>
                    </div>
                  </button>
                </div>
              </div>
            ) : (
              <div className="w-full max-w-2xl mx-auto bg-white rounded-[3rem] shadow-2xl border border-slate-100 flex flex-col h-[60vh] overflow-hidden my-auto animate-fadeIn relative">
                <div className="bg-[#1e1b4b] p-8 flex justify-between items-center text-white">
                  <div className="flex items-center gap-6">
                    <div className={`w-12 h-12 rounded-full border border-white/10 flex items-center justify-center transition-all ${isAgentSpeaking ? 'ring-8 ring-white/5 bg-white/10 scale-105' : 'bg-white/5'}`}>
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" strokeWidth={1}/></svg>
                    </div>
                    <div className="text-left">
                      <p className="font-serif text-lg font-bold italic">Sims Concierge</p>
                      <p className="text-[8px] text-[#c5a059] font-black uppercase tracking-[0.3em] mt-0.5">{isAgentSpeaking ? 'Transmitting' : 'Listening'}</p>
                    </div>
                  </div>
                  <button onClick={stopCall} className="bg-red-500/10 border border-red-500/30 hover:bg-red-500 hover:text-white text-red-500 px-8 py-2.5 rounded-full text-[9px] font-black uppercase tracking-widest transition-all">End Session</button>
                </div>
                
                <div 
                  ref={transcriptScrollRef}
                  className="flex-1 overflow-y-auto p-10 space-y-10 bg-[#fcfcfd] scroll-smooth"
                >
                   {transcriptions.map((t, i) => (
                     <div key={i} className={`flex ${t.sender === 'user' ? 'justify-end' : 'justify-start'} animate-fadeIn`}>
                       <div className={`max-w-[85%] p-5 rounded-3xl shadow-sm border ${t.sender === 'user' ? 'bg-[#1e1b4b] text-white border-[#1e1b4b] rounded-tr-none' : 'bg-white text-slate-800 border-slate-200 rounded-tl-none'}`}>
                         <p className="text-sm font-medium leading-relaxed tracking-wide">{t.text}</p>
                         <p className={`text-[7px] font-black uppercase tracking-widest mt-2 ${t.sender === 'user' ? 'text-indigo-300 text-right' : 'text-slate-400 text-left'}`}>{t.sender === 'user' ? 'Patient' : 'Concierge'}</p>
                       </div>
                     </div>
                   ))}
                   {currentInput && <div className="flex justify-end opacity-30"><div className="p-5 bg-slate-100 rounded-2xl italic text-sm">"{currentInput}"</div></div>}
                   {currentOutput && <div className="flex justify-start"><div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-xl text-sm font-medium animate-fadeIn">{currentOutput}</div></div>}
                </div>

                <div className="p-8 bg-white border-t border-slate-50 flex flex-col gap-5">
                  <div className="flex justify-between text-[8px] font-black uppercase tracking-[0.4em] text-slate-300 px-1">
                    <span>Optical Audio Stream</span>
                    <span className="text-green-600 flex items-center gap-2"><span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>System Live</span>
                  </div>
                  <div className="h-1.5 bg-slate-50 w-full flex overflow-hidden rounded-full">
                    {[...Array(80)].map((_, i) => (
                      <div key={i} className={`flex-1 transition-all duration-300 ${isAgentSpeaking ? 'bg-[#c5a059]' : 'bg-slate-200'}`} style={{ opacity: isActive ? (0.2 + Math.random() * 0.8) : 0.1 }} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col text-[#0f172a]">
      <header className="bg-[#1e1b4b] border-b border-indigo-900 px-12 py-8 flex flex-col md:flex-row justify-between items-center sticky top-0 z-50 shadow-2xl">
        <div className="flex items-center gap-8 mb-6 md:mb-0">
          <div className="w-16 h-16 bg-white rounded-xl flex items-center justify-center text-[#1e1b4b] shadow-2xl font-serif text-5xl font-bold italic">S</div>
          <div className="flex flex-col">
            <h1 className="font-serif text-4xl font-bold text-white tracking-tight">Sims Opticians</h1>
            <p className="text-[9px] text-[#c5a059] uppercase tracking-[0.5em] font-black mt-2">Bespoke Optical Eyecare</p>
          </div>
        </div>
        
        <nav className="flex gap-6 md:gap-12 overflow-x-auto w-full md:w-auto pb-4 md:pb-0 no-scrollbar">
          <NavBtn active={activeTab === 'concierge'} onClick={() => setActiveTab('concierge')} label="CONCIERGE" />
          <NavBtn active={activeTab === 'examinations'} onClick={() => setActiveTab('examinations')} label="EXAMINATIONS" />
          <NavBtn active={activeTab === 'atelier'} onClick={() => setActiveTab('atelier')} label="THE ATELIER" />
          <NavBtn active={activeTab === 'health'} onClick={() => setActiveTab('health')} label="EYE HEALTH" />
          <NavBtn active={activeTab === 'contact'} onClick={() => setActiveTab('contact')} label="CONTACT LENSES" />
        </nav>
      </header>

      <main className="flex-1 flex flex-col bg-[#fcfcfd]">
        {renderTabContent()}
      </main>

      <footer className="bg-white border-t border-slate-100 pt-24 pb-12 px-12">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-24 text-center md:text-left">
          <div className="space-y-8 flex flex-col items-center md:items-start">
            <h4 className="font-serif text-3xl text-[#1e1b4b] font-bold italic">Sims Opticians</h4>
            <p className="text-sm text-slate-400 leading-relaxed font-medium">Independent eyecare and luxury frame styling in the heart of Teddington since 1995. Our commitment is to meticulous precision and aesthetic distinction.</p>
          </div>
          <div>
            <h5 className="text-[10px] font-black uppercase tracking-[0.4em] text-[#1e1b4b] mb-8">The Practice</h5>
            <p className="text-sm text-slate-600 font-bold leading-relaxed">37 High Street<br/>Teddington, Middlesex<br/>TW11 8AS<br/><br/>020 8943 3301</p>
          </div>
          <div>
            <h5 className="text-[10px] font-black uppercase tracking-[0.4em] text-[#1e1b4b] mb-8">Practice Hours</h5>
            <div className="space-y-4 text-xs text-slate-600 font-bold">
              <div className="flex justify-between border-b border-slate-50 pb-2"><span>Mon - Fri</span><span>09:00 - 17:30</span></div>
              <div className="flex justify-between border-b border-slate-50 pb-2"><span>Saturday</span><span>09:00 - 17:00</span></div>
              <div className="flex justify-between text-slate-300"><span>Sunday</span><span>Closed</span></div>
            </div>
          </div>
          <div className="space-y-8 flex flex-col items-center md:items-start">
            <h5 className="text-[10px] font-black uppercase tracking-[0.4em] text-[#1e1b4b] mb-8">Accreditations</h5>
            <div className="flex gap-6 items-center opacity-40 grayscale">
               <div className="text-[9px] font-black tracking-widest border border-slate-300 px-3 py-1 rounded">GOC</div>
               <div className="text-[9px] font-black tracking-widest border border-slate-300 px-3 py-1 rounded">AOP</div>
               <div className="text-[9px] font-black tracking-widest border border-slate-300 px-3 py-1 rounded">NHS</div>
            </div>
          </div>
        </div>
        <div className="max-w-7xl mx-auto mt-24 pt-12 border-t border-slate-50 flex flex-col md:flex-row justify-between items-center gap-8 text-[9px] text-slate-300 font-black tracking-[0.5em] uppercase">
          <p>&copy; {new Date().getFullYear()} SIMS OPTICIANS TEDDINGTON</p>
          <div className="flex gap-16"><a href="#" className="hover:text-[#1e1b4b] transition-colors">Privacy Charter</a><a href="#" className="hover:text-[#1e1b4b] transition-colors">Practice Standards</a></div>
        </div>
      </footer>
    </div>
  );
};

const NavBtn = ({ active, onClick, label }: { active: boolean, onClick: () => void, label: string }) => (
  <button onClick={onClick} className={`text-[9px] font-black tracking-[0.3em] transition-all px-1 py-4 border-b-2 whitespace-nowrap ${active ? 'text-white border-[#c5a059]' : 'text-indigo-200 border-transparent hover:text-white'}`}>{label}</button>
);

const BrandCard = ({ name, origin, desc }: { name: string, origin: string, desc: string }) => (
  <div className="bg-white p-12 border border-slate-100 rounded-[2rem] shadow-sm hover:shadow-2xl transition-all group flex flex-col items-center text-center">
    <h4 className="font-serif text-3xl text-[#1e1b4b] group-hover:text-[#c5a059] transition-colors italic">{name}</h4>
    <p className="text-[9px] font-black text-[#c5a059] uppercase tracking-[0.4em] mt-3 mb-6">{origin}</p>
    <p className="text-xs text-slate-400 leading-relaxed font-medium">{desc}</p>
  </div>
);

const HealthService = ({ title, desc }: { title: string, desc: string }) => (
  <div className="flex flex-col md:flex-row gap-8 py-10 border-b border-slate-50 group transition-all items-center md:items-start text-center md:text-left">
    <div className="md:w-1/3">
      <h4 className="font-serif text-2xl text-[#1e1b4b] group-hover:text-[#c5a059] transition-colors font-bold">{title}</h4>
    </div>
    <div className="md:w-2/3">
      <p className="text-sm text-slate-500 leading-relaxed font-medium">{desc}</p>
    </div>
  </div>
);

export default App;
