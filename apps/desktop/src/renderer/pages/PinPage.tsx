import { useEffect, useState, useRef } from 'react';
import { posApi, StaffSession } from '../lib/posApi';
import { resolveBranding } from '../../shared/contrast';

interface Branch { id: string; name: string; desktop_licensed: boolean; }

interface Props {
  businessName: string;
  onStaffLogin: (s: StaffSession) => void;
  onBackToOwner: () => void;   // full sign-out (switch business / owner)
  onTechUnlock: () => void;    // hidden: long-press logo -> reveal code -> token
}

const PIN_MAX = 6;
const PIN_MIN = 4;

// The card the accent marks (divider, active PIN dot) sit on — current theme.
// resolveBranding vets the accent's legibility against this; change it here if the
// card colour changes.
const LOCK_SURFACE = '#0d1424';

// SwiftPOS default mark — shown in the logo slot when a client has set no logo.
// Its wordmark is dark (built for a light background), so it renders on a white
// logo-card, the same treatment as client logos.
// C2PA provenance metadata stripped; inlined so it needs no asset pipeline.
const SWIFTPOS_LOGO = "data:image/svg+xml,%3Csvg%20viewBox%3D%22116%2061%20168%20178%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3C%21--%20SwiftPOS%20App%20Badge%20%C2%B7%20Teal%20%C2%B7%20text%20outlined%20to%20paths%20%28Poppins%29%20--%3E%0A%20%20%3Crect%20x%3D%22168%22%20y%3D%2273%22%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22%230F172A%22%2F%3E%0A%20%20%3Ccircle%20fill%3D%22%230D9488%22%20cx%3D%22223%22%20cy%3D%2284%22%20r%3D%225%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22white%22%20d%3D%22M184.9075%20111.33H189.82150000000001Q189.92950000000002%20112.383%20190.5505%20112.9365Q191.1715%20113.49%20192.1705%20113.49Q193.19650000000001%20113.49%20193.7905%20113.0175Q194.3845%20112.545%20194.3845%20111.708Q194.3845%20111.006%20193.912%20110.547Q193.4395%20110.088%20192.751%20109.791Q192.0625%20109.494%20190.79350000000002%20109.116Q188.9575%20108.549%20187.7965%20107.982Q186.6355%20107.415%20185.7985%20106.30799999999999Q184.9615%20105.201%20184.9615%20103.419Q184.9615%20100.773%20186.8785%2099.27449999999999Q188.7955%2097.776%20191.8735%2097.776Q195.0055%2097.776%20196.9225%2099.27449999999999Q198.83950000000002%20100.773%20198.9745%20103.446H193.9795Q193.9255%20102.528%20193.30450000000002%20102.0015Q192.6835%20101.475%20191.7115%20101.475Q190.8745%20101.475%20190.3615%20101.9205Q189.8485%20102.366%20189.8485%20103.203Q189.8485%20104.121%20190.7125%20104.634Q191.5765%20105.147%20193.41250000000002%20105.741Q195.2485%20106.362%20196.39600000000002%20106.929Q197.54350000000002%20107.496%20198.3805%20108.576Q199.2175%20109.656%20199.2175%20111.357Q199.2175%20112.977%20198.394%20114.30000000000001Q197.5705%20115.623%20196.0045%20116.406Q194.4385%20117.189%20192.30550000000002%20117.189Q190.22650000000002%20117.189%20188.5795%20116.514Q186.9325%20115.839%20185.947%20114.51599999999999Q184.9615%20113.193%20184.9075%20111.33Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22white%22%20d%3D%22M208.5315%20110.196H205.6695V117.0H201.0525V98.04599999999999H208.5315Q210.7995%2098.04599999999999%20212.3655%2098.829Q213.9315%2099.612%20214.7145%20100.989Q215.4975%20102.366%20215.4975%20104.148Q215.4975%20105.795%20214.7415%20107.1585Q213.9855%20108.522%20212.4195%20109.35900000000001Q210.8535%20110.196%20208.5315%20110.196ZM210.7995%20104.148Q210.7995%20103.014%20210.1515%20102.393Q209.5035%20101.772%20208.1805%20101.772H205.6695V106.524H208.1805Q209.5035%20106.524%20210.1515%20105.90299999999999Q210.7995%20105.282%20210.7995%20104.148Z%22%2F%3E%0A%20%20%3C%21--%20wordmark%20--%3E%0A%20%20%3Cpath%20fill%3D%22%231E293B%22%20d%3D%22M128.26%20199.254H132.272Q132.374%20200.444%20133.411%20201.243Q134.44799999999998%20202.042%20136.012%20202.042Q137.644%20202.042%20138.54500000000002%20201.413Q139.446%20200.784%20139.446%20199.798Q139.446%20198.744%20138.44299999999998%20198.23399999999998Q137.44%20197.724%20135.26399999999998%20197.112Q133.15599999999998%20196.534%20131.82999999999998%20195.99Q130.504%20195.446%20129.535%20194.324Q128.566%20193.202%20128.566%20191.36599999999999Q128.566%20189.87%20129.45%20188.62900000000002Q130.334%20187.388%20131.983%20186.674Q133.63199999999998%20185.96%20135.774%20185.96Q138.97%20185.96%20140.925%20187.575Q142.88%20189.19%20143.016%20191.978H139.14Q139.03799999999998%20190.72%20138.12%20189.97199999999998Q137.202%20189.224%20135.63799999999998%20189.224Q134.108%20189.224%20133.292%20189.802Q132.476%20190.38%20132.476%20191.332Q132.476%20192.07999999999998%20133.01999999999998%20192.58999999999997Q133.564%20193.1%20134.346%20193.389Q135.128%20193.678%20136.658%20194.12Q138.69799999999998%20194.664%20140.007%20195.225Q141.316%20195.786%20142.268%20196.874Q143.22%20197.962%20143.254%20199.764Q143.254%20201.362%20142.37%20202.62Q141.486%20203.878%20139.87099999999998%20204.59199999999998Q138.256%20205.306%20136.07999999999998%20205.306Q133.87%20205.306%20132.119%20204.507Q130.368%20203.708%20129.348%20202.33100000000002Q128.328%20200.954%20128.26%20199.254Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%231E293B%22%20d%3D%22M172.596%20186.266%20166.78199999999998%20205.0H162.702L158.928%20191.162L155.154%20205.0H151.07399999999998L145.226%20186.266H149.17L153.07999999999998%20201.328L157.058%20186.266H161.10399999999998L164.912%20201.26L168.788%20186.266Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%231E293B%22%20d%3D%22M174.976%20181.302Q174.976%20180.248%20175.69%20179.534Q176.404%20178.82%20177.458%20178.82Q178.478%20178.82%20179.192%20179.534Q179.906%20180.248%20179.906%20181.302Q179.906%20182.356%20179.192%20183.07Q178.478%20183.784%20177.458%20183.784Q176.404%20183.784%20175.69%20183.07Q174.976%20182.356%20174.976%20181.302ZM179.362%20186.266V205.0H175.48600000000002V186.266Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%231E293B%22%20d%3D%22M192.316%20189.428H188.848V205.0H184.93800000000002V189.428H182.728V186.266H184.93800000000002V184.94Q184.93800000000002%20181.71%20186.65500000000003%20180.231Q188.372%20178.752%20192.044%20178.752V181.982Q190.276%20181.982%20189.562%20182.64499999999998Q188.848%20183.308%20188.848%20184.94V186.266H192.316Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%231E293B%22%20d%3D%22M200.27200000000002%20189.428V199.798Q200.27200000000002%20200.852%20200.76500000000001%20201.311Q201.258%20201.77%20202.448%20201.77H204.82800000000003V205.0H201.76800000000003Q199.15%20205.0%20197.75600000000003%20203.776Q196.36200000000002%20202.552%20196.36200000000002%20199.798V189.428H194.15200000000002V186.266H196.36200000000002V181.608H200.27200000000002V186.266H204.82800000000003V189.428Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%230D9488%22%20d%3D%22M216.55800000000002%20195.412H212.274V205.0H208.39800000000002V181.37H216.55800000000002Q219.27800000000002%20181.37%20221.16500000000002%20182.305Q223.05200000000002%20183.24%20223.98700000000002%20184.83800000000002Q224.92200000000003%20186.436%20224.92200000000003%20188.408Q224.92200000000003%20190.21%20224.072%20191.808Q223.222%20193.406%20221.35200000000003%20194.409Q219.48200000000003%20195.412%20216.55800000000002%20195.412ZM220.94400000000002%20188.408Q220.94400000000002%20184.532%20216.55800000000002%20184.532H212.274V192.25H216.55800000000002Q218.76800000000003%20192.25%20219.85600000000002%20191.247Q220.94400000000002%20190.244%20220.94400000000002%20188.408Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%230D9488%22%20d%3D%22M227.336%20193.134Q227.336%20189.666%20228.95100000000002%20186.91199999999998Q230.566%20184.158%20233.337%20182.611Q236.108%20181.064%20239.406%20181.064Q242.738%20181.064%20245.50900000000001%20182.611Q248.28%20184.158%20249.878%20186.91199999999998Q251.476%20189.666%20251.476%20193.134Q251.476%20196.602%20249.878%20199.373Q248.28%20202.144%20245.50900000000001%20203.691Q242.738%20205.238%20239.406%20205.238Q236.108%20205.238%20233.337%20203.691Q230.566%20202.144%20228.95100000000002%20199.373Q227.336%20196.602%20227.336%20193.134ZM247.498%20193.134Q247.498%20190.516%20246.461%20188.54399999999998Q245.424%20186.572%20243.58800000000002%20185.518Q241.752%20184.464%20239.406%20184.464Q237.06%20184.464%20235.224%20185.518Q233.388%20186.572%20232.351%20188.54399999999998Q231.314%20190.516%20231.314%20193.134Q231.314%20195.752%20232.351%20197.74099999999999Q233.388%20199.73%20235.224%20200.801Q237.06%20201.872%20239.406%20201.872Q241.752%20201.872%20243.58800000000002%20200.801Q245.424%20199.73%20246.461%20197.74099999999999Q247.498%20195.752%20247.498%20193.134Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%230D9488%22%20d%3D%22M254.70600000000002%20198.472H258.854Q258.99%20200.002%20260.06100000000004%20200.988Q261.132%20201.974%20263.07%20201.974Q265.076%20201.974%20266.198%20201.005Q267.32%20200.036%20267.32%20198.506Q267.32%20197.316%20266.623%20196.56799999999998Q265.926%20195.82%20264.889%20195.41199999999998Q263.85200000000003%20195.004%20262.016%20194.528Q259.704%20193.916%20258.259%20193.28699999999998Q256.814%20192.658%20255.794%20191.332Q254.774%20190.006%20254.774%20187.796Q254.774%20185.756%20255.794%20184.226Q256.814%20182.696%20258.65%20181.88Q260.486%20181.064%20262.90000000000003%20181.064Q266.334%20181.064%20268.52700000000004%20182.781Q270.72%20184.498%20270.958%20187.49H266.67400000000004Q266.572%20186.198%20265.45000000000005%20185.28Q264.32800000000003%20184.362%20262.492%20184.362Q260.826%20184.362%20259.77200000000005%20185.212Q258.718%20186.062%20258.718%20187.66Q258.718%20188.748%20259.381%20189.445Q260.044%20190.142%20261.06399999999996%20190.55Q262.084%20190.958%20263.85200000000003%20191.434Q266.19800000000004%20192.07999999999998%20267.677%20192.726Q269.156%20193.372%20270.193%20194.715Q271.23%20196.058%20271.23%20198.302Q271.23%20200.10399999999998%20270.261%20201.702Q269.29200000000003%20203.3%20267.439%20204.269Q265.586%20205.238%20263.07%20205.238Q260.69%20205.238%20258.786%20204.405Q256.882%20203.572%20255.794%20202.042Q254.70600000000002%20200.512%20254.70600000000002%20198.472Z%22%2F%3E%0A%20%20%3C%21--%20tagline%20--%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M150.314%20223.508H148.706V227.0H147.614V218.636H150.314Q151.73%20218.636%20152.468%20219.32Q153.206%20220.004%20153.206%20221.084Q153.206%20222.128%20152.492%20222.81799999999998Q151.778%20223.508%20150.314%20223.508ZM152.09%20221.084Q152.09%20219.536%20150.314%20219.536H148.706V222.608H150.314Q151.226%20222.608%20151.65800000000002%20222.212Q152.09%20221.816%20152.09%20221.084Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M156.154%20222.812Q156.154%20221.588%20156.712%20220.61Q157.27%20219.632%20158.23000000000002%20219.086Q159.19%20218.54%20160.354%20218.54Q161.53%20218.54%20162.49%20219.086Q163.45000000000002%20219.632%20164.002%20220.60399999999998Q164.554%20221.576%20164.554%20222.812Q164.554%20224.048%20164.002%20225.01999999999998Q163.45000000000002%20225.992%20162.49%20226.538Q161.53%20227.084%20160.354%20227.084Q159.19%20227.084%20158.23000000000002%20226.538Q157.27%20225.992%20156.712%20225.014Q156.154%20224.036%20156.154%20222.812ZM163.43800000000002%20222.812Q163.43800000000002%20221.804%20163.036%20221.054Q162.63400000000001%20220.304%20161.93800000000002%20219.89600000000002Q161.24200000000002%20219.488%20160.354%20219.488Q159.466%20219.488%20158.77%20219.89600000000002Q158.074%20220.304%20157.67200000000003%20221.054Q157.27%20221.804%20157.27%20222.812Q157.27%20223.808%20157.67200000000003%20224.564Q158.074%20225.32%20158.776%20225.728Q159.478%20226.136%20160.354%20226.136Q161.23000000000002%20226.136%20161.93200000000002%20225.728Q162.63400000000001%20225.32%20163.036%20224.564Q163.43800000000002%20223.808%20163.43800000000002%20222.812Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M169.08599999999998%20218.636V227.0H167.994V218.636Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M179.522%20227.0H178.42999999999998L174.03799999999998%20220.34V227.0H172.946V218.624H174.03799999999998L178.42999999999998%20225.272V218.624H179.522Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M188.53%20218.636V219.524H186.25V227.0H185.158V219.524H182.86599999999999V218.636Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M196.67%20222.812Q196.67%20221.588%20197.228%20220.61Q197.786%20219.632%20198.74599999999998%20219.086Q199.706%20218.54%20200.87%20218.54Q202.046%20218.54%20203.006%20219.086Q203.966%20219.632%20204.518%20220.60399999999998Q205.07%20221.576%20205.07%20222.812Q205.07%20224.048%20204.518%20225.01999999999998Q203.966%20225.992%20203.006%20226.538Q202.046%20227.084%20200.87%20227.084Q199.706%20227.084%20198.74599999999998%20226.538Q197.786%20225.992%20197.228%20225.014Q196.67%20224.036%20196.67%20222.812ZM203.954%20222.812Q203.954%20221.804%20203.55200000000002%20221.054Q203.15%20220.304%20202.454%20219.89600000000002Q201.758%20219.488%20200.87%20219.488Q199.982%20219.488%20199.286%20219.89600000000002Q198.59%20220.304%20198.188%20221.054Q197.786%20221.804%20197.786%20222.812Q197.786%20223.808%20198.188%20224.564Q198.59%20225.32%20199.292%20225.728Q199.994%20226.136%20200.87%20226.136Q201.746%20226.136%20202.448%20225.728Q203.15%20225.32%20203.55200000000002%20224.564Q203.954%20223.808%20203.954%20222.812Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M213.23799999999997%20218.636V219.524H209.60199999999998V222.344H212.55399999999997V223.232H209.60199999999998V227.0H208.51V218.636Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M221.522%20224.768H222.686Q222.74599999999998%20225.356%20223.17199999999997%20225.75799999999998Q223.59799999999998%20226.16%20224.414%20226.16Q225.194%20226.16%20225.644%20225.76999999999998Q226.094%20225.38%20226.094%20224.768Q226.094%20224.288%20225.82999999999998%20223.988Q225.566%20223.688%20225.17000000000002%20223.53199999999998Q224.774%20223.376%20224.102%20223.196Q223.274%20222.98%20222.776%20222.764Q222.278%20222.548%20221.92399999999998%20222.086Q221.57%20221.624%20221.57%20220.844Q221.57%20220.16%20221.918%20219.632Q222.266%20219.104%20222.896%20218.816Q223.52599999999998%20218.528%20224.34199999999998%20218.528Q225.518%20218.528%20226.268%20219.11599999999999Q227.018%20219.704%20227.114%20220.676H225.914Q225.85399999999998%20220.196%20225.41%20219.82999999999998Q224.966%20219.464%20224.23399999999998%20219.464Q223.54999999999998%20219.464%20223.118%20219.81799999999998Q222.686%20220.172%20222.686%20220.808Q222.686%20221.264%20222.94400000000002%20221.55200000000002Q223.202%20221.84%20223.57999999999998%20221.99Q223.958%20222.14%20224.642%20222.332Q225.47%20222.56%20225.974%20222.78199999999998Q226.47799999999998%20223.004%20226.838%20223.466Q227.198%20223.928%20227.198%20224.72Q227.198%20225.332%20226.874%20225.872Q226.54999999999998%20226.412%20225.914%20226.748Q225.278%20227.084%20224.414%20227.084Q223.58599999999998%20227.084%20222.932%20226.79000000000002Q222.278%20226.496%20221.906%20225.974Q221.534%20225.452%20221.522%20224.768Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M235.75%20225.14H232.102L231.43%20227.0H230.278L233.302%20218.684H234.562L237.574%20227.0H236.422ZM235.43800000000002%20224.252%20233.92600000000002%20220.028%20232.41400000000002%20224.252Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M241.986%20226.112H244.914V227.0H240.894V218.636H241.986Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M249.17%20219.524V222.32H252.218V223.22H249.17V226.1H252.578V227.0H248.078V218.624H252.578V219.524Z%22%2F%3E%0A%3C%2Fsvg%3E";

export default function PinPage({ businessName, onStaffLogin, onBackToOwner, onTechUnlock }: Props) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(true);
  // Two taps to sign the business out. The button only shows on a screen
  // that is already broken, which is exactly when someone is jabbing at it.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  // ── A295 branding seam ────────────────────────────────────────────────────
  // Until the branding read lands (a later, sync-dependent slice) these are null,
  // so resolveBranding returns the SwiftPOS default: the screen renders today's
  // green look inside the new layout. Wire accentHex / logoDataUri to branding:get
  // when that slice ships — nothing else here changes.
  const accentHex: string | null = null;
  const logoDataUri: string | null = null;
  const brand = resolveBranding(accentHex, LOCK_SURFACE);

  // ── Hidden tech entry: long-press the logo -> reveal code -> token ──
  const [techStage, setTechStage] = useState<null | 'reveal' | 'token'>(null);
  const [revealInput, setRevealInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [techBusy, setTechBusy] = useState(false);
  const [techErr, setTechErr] = useState('');
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startPress = () => {
    pressTimer.current = setTimeout(() => { setTechErr(''); setRevealInput(''); setTechStage('reveal'); }, 800);
  };
  const cancelPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };
  const closeTech = () => { setTechStage(null); setRevealInput(''); setTokenInput(''); setTechErr(''); };

  const submitReveal = async () => {
    setTechBusy(true); setTechErr('');
    try {
      const r = await posApi.tech.checkReveal(revealInput.trim());
      if (r.ok) { setTokenInput(''); setTechStage('token'); }
      else setTechErr('Incorrect code');
    } catch (e: any) { setTechErr(e?.message ?? 'Check failed'); }
    finally { setTechBusy(false); }
  };

  const submitToken = async () => {
    setTechBusy(true); setTechErr('');
    try {
      const r = await posApi.tech.openSession(tokenInput.trim());
      if (r.ok) { closeTech(); onTechUnlock(); }
      else setTechErr((r as { ok: false; error: string }).error || 'Invalid token');
    } catch (e: any) { setTechErr(e?.message ?? 'Verification failed'); }
    finally { setTechBusy(false); }
  };
  // Like the web POS: the branch is chosen once and remembered (bound to the
  // device), so the PIN pad doesn't ask again. The cashier-facing "change" is
  // gone (A295 §2 — branch re-bind lives behind the technician gate); the picker
  // still appears on first run or when no valid branch is bound.
  const [showBranchPicker, setShowBranchPicker] = useState(false);

  // Load branches the owner can see; prefer the device's bound branch,
  // else auto-select if only one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await posApi.auth.listBranches();
        if (cancelled) return;
        setBranches(list);
        const cfg = await posApi.config.get().catch(() => null);
        const bound = cfg?.branch_id && list.some(b => b.id === cfg.branch_id) ? cfg.branch_id : null;
        if (bound) setBranchId(bound);
        else if (list.length === 1) setBranchId(list[0].id);
        else setShowBranchPicker(true);   // first run, multiple branches — must pick once
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load branches');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const press = (d: string) => {
    setError('');
    setPin(p => (p.length >= PIN_MAX ? p : p + d));
  };
  const backspace = () => { setError(''); setPin(p => p.slice(0, -1)); };
  const clear = () => { setError(''); setPin(''); };

  const submit = async () => {
    if (!branchId) { setError('Select a branch first'); return; }
    if (pin.length < PIN_MIN) { setError(`PIN must be ${PIN_MIN}–${PIN_MAX} digits`); return; }
    setVerifying(true);
    setError('');
    try {
      const session = await posApi.auth.verifyPin(pin, branchId);
      onStaffLogin(session);
    } catch (e: any) {
      setError(e?.message ?? 'Invalid PIN');
      setPin('');
      setVerifying(false);
    }
  };

  // Allow the physical keyboard too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (verifying) return;
      if (e.key >= '0' && e.key <= '9') press(e.key);
      else if (e.key === 'Backspace') backspace();
      else if (e.key === 'Enter') submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // re-bind each render so `submit` closes over current pin/branchId

  const selectedBranch = branches.find(b => b.id === branchId);
  const branchUnlicensed = selectedBranch && !selectedBranch.desktop_licensed;

  return (
    <div className="min-h-screen bg-[#080c14] flex flex-col items-center justify-center px-4">
      {techStage && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-50" onClick={closeTech}>
          <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            {techStage === 'reveal' ? (
              <>
                <h2 className="text-lg font-bold text-white">Technician access</h2>
                <p className="text-xs text-gray-300 mt-1 mb-4">Enter the branch access code.</p>
                <input
                  autoFocus value={revealInput}
                  onChange={e => { setRevealInput(e.target.value.toUpperCase()); setTechErr(''); }}
                  onPaste={e => {
                    // D18: a tech often has only the token (admin Tech Access hands
                    // out the token, not a reveal code). Pasting it here would hit
                    // maxLength/upper-casing and truncate — "not allowing the full
                    // string". Detect a token and jump straight to the token step
                    // with the full value. The reveal code is a low-value doorknock;
                    // the token is branch-scoped and cryptographically verified.
                    const text = e.clipboardData.getData('text').trim();
                    if (text.startsWith('st2.')) {
                      e.preventDefault();
                      setTokenInput(text);
                      setTechErr('');
                      setTechStage('token');
                    }
                  }}
                  onKeyDown={e => e.key === 'Enter' && submitReveal()}
                  placeholder="ACCESS CODE" maxLength={12}
                  className="w-full bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-4 py-2.5 text-white text-center font-mono tracking-widest uppercase focus:outline-none focus:border-green-500"
                />
                {techErr && <p className="text-red-400 text-xs mt-2 text-center">{techErr}</p>}
                <div className="flex gap-2 mt-4">
                  <button onClick={closeTech} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] text-gray-300 rounded-lg py-2.5 text-sm">Cancel</button>
                  <button onClick={submitReveal} disabled={techBusy || revealInput.trim().length < 4}
                    className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm">
                    {techBusy ? '…' : 'Continue'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-lg font-bold text-white">Technician token</h2>
                <p className="text-xs text-gray-300 mt-1 mb-4">Paste the access token issued for this branch.</p>
                <textarea
                  autoFocus value={tokenInput}
                  onChange={e => { setTokenInput(e.target.value); setTechErr(''); }}
                  placeholder="st2.…" rows={3}
                  className="w-full bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-3 py-2 text-white text-xs font-mono break-all focus:outline-none focus:border-green-500 resize-none"
                />
                {techErr && <p className="text-red-400 text-xs mt-2 text-center">{techErr}</p>}
                <div className="flex gap-2 mt-4">
                  <button onClick={() => { setTechStage('reveal'); setTechErr(''); }} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] text-gray-300 rounded-lg py-2.5 text-sm">Back</button>
                  <button onClick={submitToken} disabled={techBusy || tokenInput.trim().length < 10}
                    className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm">
                    {techBusy ? 'Verifying…' : 'Unlock'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Fixed, centred lock card — same size on a till as on a wide monitor. */}
      <div
        className="rounded-2xl border border-[#1e293b] overflow-hidden grid"
        style={{ width: 720, maxWidth: '100%', height: 500, gridTemplateColumns: '1fr 1px 1.05fr', background: '#0d1424' }}
      >
        {/* ── LEFT: identity (centred both axes) ── */}
        <div className="flex flex-col items-center justify-center text-center px-8">
          {/* Logo (on a light card) or the business wordmark. Long-press here is
              the hidden technician entry (moved off the plain name text). */}
          <div
            className="select-none cursor-default"
            onPointerDown={startPress}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
          >
            {logoDataUri ? (
              <span className="inline-flex items-center justify-center bg-white rounded-xl" style={{ padding: '12px 18px' }}>
                <img src={logoDataUri} alt="" style={{ maxHeight: 88, maxWidth: 220, objectFit: 'contain', display: 'block' }} />
              </span>
            ) : (
              // No client logo -> the SwiftPOS default mark. Its wordmark is dark
              // (built for a light background), so it sits on the same white card
              // as client logos rather than on the dark surface.
              <span className="inline-flex items-center justify-center bg-white rounded-xl" style={{ padding: '18px 22px' }}>
                <img src={SWIFTPOS_LOGO} alt="SwiftPOS" style={{ height: 150, width: 'auto', maxWidth: 210, display: 'block' }} />
              </span>
            )}
          </div>

          <div className="text-xl font-bold mt-4" style={{ color: brand.accent }}>{businessName}</div>

          {/* Branch — bound to the device; a chip once bound, a picker on first run. */}
          <div className="mt-4 w-full max-w-[240px]">
            {loading ? (
              <div className="h-10 rounded-lg bg-[#0f172a] animate-pulse" />
            ) : branches.length === 0 ? (
              <p className="text-sm text-gray-300">No branches available.</p>
            ) : showBranchPicker || !selectedBranch ? (
              <select
                value={branchId ?? ''}
                onChange={e => { setBranchId(e.target.value || null); setError(''); setShowBranchPicker(false); }}
                className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-green-500"
              >
                <option value="">Select branch…</option>
                {branches.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}{b.desktop_licensed ? '' : ' (no desktop licence)'}
                  </option>
                ))}
              </select>
            ) : (
              <div className="inline-flex items-center gap-2 bg-[#0f172a] border border-[#1e293b] rounded-lg px-4 py-2 text-sm text-gray-400">
                Branch: <span className="text-gray-200">{selectedBranch.name}</span>
              </div>
            )}
          </div>

          {branchUnlicensed && (
            <p className="mt-3 text-amber-400 text-xs bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2 max-w-[240px]">
              This branch has no desktop licence. Contact SwiftPOS to activate it.
            </p>
          )}

          <div className="mt-6 text-[11px] text-gray-500 flex items-center gap-1.5">
            <span>🔒</span> powered by <b className="text-gray-400 font-semibold">SwiftPOS</b>
          </div>
        </div>

        {/* ── divider (accent) ── */}
        <div style={{ background: `linear-gradient(to bottom, transparent, ${brand.accent} 18%, ${brand.accent} 82%, transparent)`, opacity: 0.55 }} />

        {/* ── RIGHT: keypad ── */}
        <div className="flex flex-col justify-center px-10">
          <div className="w-full max-w-[300px] mx-auto">
            <p className="text-gray-300 text-sm text-center">Enter your PIN</p>
            <p className="text-gray-500 text-xs mb-4 text-center">to start a shift</p>

            {/* PIN dots */}
            <div className="flex gap-3 mb-5 justify-center">
              {Array.from({ length: PIN_MAX }).map((_, i) => (
                <span
                  key={i}
                  className={`w-3.5 h-3.5 rounded-full border ${i < pin.length ? '' : 'border-gray-600'}`}
                  style={i < pin.length ? { backgroundColor: brand.accent, borderColor: brand.accent } : undefined}
                />
              ))}
            </div>

            {error && (
              <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5 text-center mb-4">
                {error}
              </p>
            )}

            {/* Keypad */}
            <div className="grid grid-cols-3 gap-2.5">
              {['1','2','3','4','5','6','7','8','9'].map(d => (
                <button
                  key={d}
                  onClick={() => press(d)}
                  disabled={verifying}
                  className="rounded-xl bg-[#0f172a] hover:bg-gray-700 text-white text-lg font-semibold disabled:opacity-40 focus:outline-none flex items-center justify-center"
                  style={{ aspectRatio: '1.6' }}
                >
                  {d}
                </button>
              ))}
              <button
                onClick={clear}
                disabled={verifying}
                className="rounded-xl bg-[#0f172a] hover:bg-gray-700 text-gray-400 text-sm disabled:opacity-40 focus:outline-none flex items-center justify-center"
                style={{ aspectRatio: '1.6' }}
              >
                Clear
              </button>
              <button
                onClick={() => press('0')}
                disabled={verifying}
                className="rounded-xl bg-[#0f172a] hover:bg-gray-700 text-white text-lg font-semibold disabled:opacity-40 focus:outline-none flex items-center justify-center"
                style={{ aspectRatio: '1.6' }}
              >
                0
              </button>
              <button
                onClick={backspace}
                disabled={verifying}
                className="rounded-xl bg-[#0f172a] hover:bg-gray-700 text-gray-400 text-lg disabled:opacity-40 focus:outline-none flex items-center justify-center"
                style={{ aspectRatio: '1.6' }}
              >
                ⌫
              </button>
            </div>

            <button
              onClick={submit}
              disabled={verifying || !branchId || pin.length < PIN_MIN}
              style={{ backgroundColor: brand.accent, color: brand.buttonText }}
              className="w-full disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none font-bold rounded-xl py-3 mt-3.5 transition-[filter] hover:brightness-110"
            >
              {verifying ? 'Verifying…' : 'Enter'}
            </button>
          </div>
        </div>
      </div>

      {/* Signing out the OWNER is not a cashier's action — restoring it needs
          the owner's email and password, which nobody on the floor has at
          07:00. It lives on the manager screen instead.

          The exception is when this screen cannot function: no branches
          loaded, or the session failed outright. Hiding it unconditionally
          would mean a till whose refresh token has died is bricked, with no
          route to sign in again. So it appears only as a way out of a screen
          that is already broken. */}
      {(error || branches.length === 0) && !loading && (
        confirmSignOut ? (
          <div className="mt-6 border border-gray-800 rounded-xl p-3 w-full max-w-sm">
            <p className="text-xs text-gray-200 text-center">
              Sign this till out of the business?
            </p>
            <p className="text-xs text-gray-400 text-center mt-1">
              Getting back in needs the owner's email and password. Staff PINs will
              not work until then.
            </p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => setConfirmSignOut(false)}
                className="flex-1 py-2 rounded-lg text-xs border border-gray-700 text-gray-200 hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onBackToOwner}
                className="flex-1 py-2 rounded-lg text-xs bg-red-600 hover:bg-red-500 text-white transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmSignOut(true)}
            className="text-center text-gray-400 hover:text-white text-xs mt-6"
          >
            Sign out / switch account
          </button>
        )
      )}
    </div>
  );
}
