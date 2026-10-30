// Medical items and services that commonly require prior authorization in this demo plan.
// CMS-0057-F metrics exclude drugs, so none are listed here.

export interface Service {
  code: string;
  description: string;
  keywords: string[]; // used to recover a code from free-text call notes
}

export const SERVICES: Service[] = [
  { code: '72148', description: 'MRI lumbar spine without contrast', keywords: ['mri lumbar', 'lumbar mri', 'mri low back'] },
  { code: '70553', description: 'MRI brain with and without contrast', keywords: ['mri brain', 'brain mri'] },
  { code: '73721', description: 'MRI knee without contrast', keywords: ['mri knee', 'knee mri'] },
  { code: '78815', description: 'PET/CT skull base to mid-thigh', keywords: ['pet', 'pet ct', 'pet scan'] },
  { code: '27447', description: 'Total knee arthroplasty', keywords: ['knee replacement', 'total knee', 'tka'] },
  { code: '29881', description: 'Knee arthroscopy with meniscectomy', keywords: ['arthroscopy', 'scope knee', 'meniscus'] },
  { code: '63030', description: 'Lumbar laminotomy, single interspace', keywords: ['laminotomy', 'back surgery', 'decompression'] },
  { code: '43239', description: 'Upper GI endoscopy with biopsy', keywords: ['endoscopy', 'egd', 'upper gi'] },
  { code: '95810', description: 'Attended polysomnography (sleep study)', keywords: ['sleep study', 'polysomnography'] },
  { code: 'E0601', description: 'CPAP device', keywords: ['cpap'] },
  { code: '97110', description: 'Physical therapy, therapeutic exercise', keywords: ['physical therapy', 'pt visits', 'therapy visits'] },
  { code: '93306', description: 'Echocardiogram, complete', keywords: ['echo', 'echocardiogram'] },
];

export const SERVICE_BY_CODE = new Map(SERVICES.map((s) => [s.code, s]));

/** Recover a service code from a free-text note ("pt needs MRI lumbar spine"). */
export function serviceFromText(note: string | undefined): string | undefined {
  if (!note) return undefined;
  const n = note.toLowerCase();
  let best: { code: string; len: number } | undefined;
  for (const s of SERVICES) {
    for (const k of s.keywords) {
      if (n.includes(k) && (!best || k.length > best.len)) best = { code: s.code, len: k.length };
    }
  }
  return best?.code;
}
