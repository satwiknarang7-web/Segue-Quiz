/**
 * The SegueIT AI Quiz, imported from its Google Form.
 *
 * https://docs.google.com/forms/d/e/1FAIpQLSeSV5Fig35B0NEYAC58U3NJzc5uHZhbDLSz5b1apgv87tmiog/viewform
 *
 * Google does not publish a form's answer key, so every `correctIndex` here was
 * derived from the subject matter rather than copied from the form. Check them
 * against your own key before running the quiz for real.
 *
 * This is the single source of truth: both the dashboard's one-click import and
 * scripts/import-ai-quiz.mjs read it, so the two cannot drift apart.
 */

export const AI_QUIZ = {
  title: 'SegueIT AI Quiz',
  description: '15 questions on agentic AI, RAG, large language models and modern automation.',
  timeLimitSeconds: 15 * 60,
};

export const AI_QUIZ_QUESTIONS = [
  {
    text: 'What fundamentally distinguishes an "Agentic AI" system from a traditional rule-based expert system?',
    options: [
      'Uses strict if-then rules.',
      'Plans and acts autonomously.',
      'Requires constant human input.',
      'Cannot use external tools.',
    ],
    correctIndex: 1,
  },
  {
    text: 'In reinforcement learning-based AI agents, what is the primary role of the "reward function"?',
    options: [
      'Compresses neural networks.',
      'Generates action logs.',
      'Evaluates actions to guide learning.',
      'Formats text outputs.',
    ],
    correctIndex: 2,
  },
  {
    text: 'What is a primary challenge that multi-agent orchestration frameworks (like AutoGen or CrewAI) aim to solve?',
    options: [
      'Reducing model parameters.',
      'Coordinating multiple autonomous agents.',
      'Generating high-res images.',
      'Bypassing hardware limits.',
    ],
    correctIndex: 1,
  },
  {
    text: 'In a cooperative multi-agent system, what does the term "consensus mechanism" refer to?',
    options: [
      'A method for agents to agree on a shared state, truth, or final decision.',
      'A prompt engineering technique to make LLMs more polite.',
      'The process of compressing multiple models into one.',
      'The automatic scaling of cloud servers based on traffic.',
    ],
    correctIndex: 0,
  },
  {
    text: 'What critical limitation of foundational Large Language Models (LLMs) does Retrieval-Augmented Generation (RAG) directly address?',
    options: [
      'High inference latency.',
      'Poor grammar understanding.',
      'Outdated knowledge and lack of private data.',
      'Vanishing gradient problem.',
    ],
    correctIndex: 2,
  },
  {
    text: 'Which metric is most appropriate for evaluating the retrieval component of a RAG pipeline?',
    options: ['BLEU score', 'MRR or NDCG', 'Cross-entropy loss', 'Token generation speed'],
    correctIndex: 1,
  },
  {
    text: 'What is the core architectural innovation introduced in the "Attention Is All You Need" paper that powers modern LLMs?',
    options: [
      'Long Short-Term Memory (LSTM) cells',
      'Generative Adversarial Networks (GANs)',
      'The Self-Attention mechanism',
      'Convolutional pooling layers',
    ],
    correctIndex: 2,
  },
  {
    text: 'What is "LoRA" (Low-Rank Adaptation) primarily used for in the context of Large Language Models?',
    options: [
      'Parameter-efficient fine-tuning (PEFT).',
      'Pre-training from scratch.',
      'Translating text to SQL.',
      'Increasing context window size.',
    ],
    correctIndex: 0,
  },
  {
    text: 'How does AI primarily enhance modern cloud infrastructure management (often referred to as AIOps)?',
    options: [
      'Replacing cloud architects with bots.',
      'Automating scaling and anomaly detection.',
      'Eliminating data centers.',
      'Rewriting operating systems.',
    ],
    correctIndex: 1,
  },
  {
    text: 'What is "Prompt Injection"?',
    options: [
      'Hacking AI SQL databases.',
      'Bypassing safety guardrails via malicious inputs.',
      'Injecting code into model weights.',
      'Method to speed up fine-tuning.',
    ],
    correctIndex: 1,
  },
  {
    text: 'What is the fundamental difference between traditional Robotic Process Automation (RPA) and AI-driven Intelligent Automation?',
    options: [
      'RPA is for Mac; AI is for Windows.',
      'RPA uses static rules; AI makes cognitive decisions.',
      'RPA is cloud-based; AI is local.',
      'No functional difference.',
    ],
    correctIndex: 1,
  },
  {
    text: 'According to recent industry trends, which combination of skills is heavily sought after for modern "AI Engineer" roles, as opposed to traditional ML Researchers?',
    options: [
      'Custom kernels and new math architectures.',
      'Software engineering, APIs, prompting, and RAG.',
      'Pure math and academic publishing.',
      'Front-end UI/UX design and CSS frameworks.',
    ],
    correctIndex: 1,
  },
  {
    text: 'What type of workplace data, previously difficult to automate with traditional software, has Generative AI made highly accessible for automation?',
    options: [
      'Structured SQL databases.',
      'Binary executable files.',
      'Unstructured text, audio, and emails.',
      'Simple numeric spreadsheets.',
    ],
    correctIndex: 2,
  },
  {
    text: 'When designing a complex multi-agent system, what is the purpose of using a Directed Acyclic Graph (DAG) for workflow execution?',
    options: [
      'To create communication loops.',
      'To define strict, non-circular task sequences.',
      'To compress the context window.',
      'To randomly assign tasks.',
    ],
    correctIndex: 1,
  },
  {
    text: 'What is the primary benefit of applying "Quantization" (e.g., INT8 or INT4) to a Large Language Model?',
    options: [
      'Increases model parameters.',
      'Lowers VRAM and speeds up inference.',
      'Enables infinite context lengths.',
      'Guarantees unbiased outputs.',
    ],
    correctIndex: 1,
  },
];