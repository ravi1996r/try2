"""
One-shot content writer for content/profile.json.

WHY: piecemeal edits to a 200-line nested JSON file produced two unbalanced-brace failures in a
row. Writing the document from a Python dict and serialising with json.dump cannot emit invalid
JSON, and the resulting file stays diffable and reviewable.
ALTERNATIVES: (a) keep hand-editing the JSON, (b) move content into code, (c) YAML front matter.
WHY NOT: (a) already failed twice; (b) makes content harder to review; (c) needs a YAML parser in
   both runtimes for no benefit over JSON here.
TRADE-OFF: this is a scaffolder, not a build step. Once the file is correct the owner edits
   content/profile.json directly, which is the documented update path in the README.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'content' / 'profile.json'
RESUME = 'inputs/Ravi_Ranjan_Prasad_Resume.pdf'
CERT_SRC = 'resume p.2 CERTIFICATIONS & ACHIEVEMENTS'

profile = {
    "schema_version": 1,
    "identity": {
        "full_name": "Ravi Ranjan Prasad",
        "headline": "Full Stack Chatbot Developer | Generative AI & Backend Engineer",
        "location": "Faridabad, Delhi NCR, India",
        # WHY: the hero line restates the resume summary rather than adding a new claim, and is
        # recorded as derived in source_register so it is not mistaken for a resume quote.
        "tagline": "Six years building enterprise conversational AI and the high-concurrency backend services behind it.",
    },
    "summary": (
        "Full Stack Chatbot Developer and AI Engineer with 6+ years of experience designing, developing "
        "and supporting enterprise conversational AI applications and high-concurrency backend services. "
        "Experienced in building Generative AI assistants end to end, including LLM integration, prompt "
        "engineering, Retrieval-Augmented Generation (RAG), knowledge retrieval and conversation-state "
        "management. Strong backend expertise in Python (FastAPI), Node.js, REST APIs, MongoDB, Redis and "
        "microservices, with hands-on experience deploying applications on Microsoft Azure (App Service, "
        "Azure Functions) and implementing GitHub Actions CI/CD pipelines. Experienced in integrating "
        "enterprise platforms including ServiceNow (Incident Management, Knowledge Base, Service Catalog), "
        "Genesys Live Chat, and multi-tenant architecture with Microsoft Teams, Zoom and Google Chat, along "
        "with application monitoring, performance optimization, production troubleshooting and "
        "zero-downtime deployments."
    ),
    "skills": [
        {"category": "Languages", "items": ["JavaScript", "TypeScript", "Python", "SQL"]},
        {"category": "Backend & Frameworks", "items": [
            "Node.js", "NestJS", "Express", "FastAPI", "REST API design",
            "Microsoft Bot Framework", "Microservices", "Asynchronous processing",
        ]},
        {"category": "Generative AI / Conversational AI", "items": [
            "LLM integration (Azure OpenAI, GPT-4.1 & mini)", "Prompt engineering", "RAG pipelines",
            "Vector search and embeddings", "Agentic / multi-turn dialogue design",
            "Intent handling, fallback and escalation logic", "Chatbot evaluation metrics",
        ]},
        {"category": "Cloud & DevOps", "items": [
            "Microsoft Azure (App Service, Azure Functions, Azure OpenAI, Azure AI Search, Cosmos DB, "
            "Application Insights, Key Vault)", "CI/CD pipeline design", "GitHub Actions",
            "Azure DevOps Pipelines", "Docker", "Git", "Blue-green and zero-downtime deployments",
        ]},
        {"category": "Databases & Caching", "items": [
            "MongoDB", "Cosmos DB", "Redis", "Query optimization", "Indexing", "Caching strategy",
        ]},
        {"category": "Enterprise Integrations", "items": [
            "ServiceNow (Incident/Ticketing, Knowledge Base, Interactions, Service Catalog)",
            "Genesys Live Chat", "Microsoft Teams", "Zoom API", "Azure AD authentication", "Webhooks",
        ]},
        {"category": "Practices", "items": [
            "Agile / Scrum", "Code reviews", "Unit and integration testing", "Observability and logging",
            "Production support", "Technical documentation", "Knowledge transfer",
        ]},
    ],
}

profile["experience"] = [
    {
        "employer": "Tata Consultancy Services (TCS)",
        "role": "Full Stack Chatbot Developer / AI Backend Engineer",
        "start": "2021-10",
        "end": "Present",
        "summary": (
            "Building and supporting enterprise conversational AI backends for global IT support, "
            "most recently the ExxonMobil Enterprise AI Assistant (ITChat)."
        ),
        "clients": [
            {
                "name": "Exxon Mobil Corporation",
                "project": "Enterprise AI Assistant (ITChat)",
                "start": "2024-09",
                "end": "Present",
                "summary": "Enterprise Generative AI assistant for global IT support.",
                "highlights": [
                    "Developed and maintained backend services for an enterprise Generative AI assistant using Python (FastAPI) and Node.js, supporting high-concurrency conversational workloads for global IT support.",
                    "Engineered GenAI workflows covering LLM integration, prompt engineering, response grounding, conversation context/state management, and fallback handling for low-confidence responses.",
                    "Designed and enhanced Retrieval-Augmented Generation (RAG) pipelines over enterprise knowledge sources such as policy documents, IT runbooks and knowledge base articles, including document chunking, embedding refresh, retrieval optimization and relevance tuning.",
                    "Integrated ServiceNow REST APIs for incident creation, ticket status lookup and service catalog requests, enabling IT transactions directly through Microsoft Teams.",
                    "Deployed backend services on Microsoft Azure (App Service, Azure Functions) and implemented GitHub Actions CI/CD for automated build, test and deployment workflows.",
                    "Implemented Azure Application Insights telemetry and optimized application performance through caching, query tuning and asynchronous processing, monitoring latency, error rates and fallback behavior.",
                    "Collaborated with QA teams and client stakeholders across UAT, production releases, defect resolution and post-release validation.",
                ],
            },
            {
                "name": "Shell plc",
                "project": "IT Support Chatbot (Sam)",
                "start": "2021-10",
                "end": "2024-09",
                "summary": "Enterprise IT support chatbot across Web and Microsoft Teams.",
                "highlights": [
                    "Developed and enhanced an enterprise IT support chatbot using Microsoft Bot Framework and Node.js, supporting multi-turn conversations, context retention, Adaptive Cards and fallback handling across Web and Microsoft Teams.",
                    "Implemented Natural Language Processing (NLP) capabilities using Azure Conversational Language Understanding (CLU) to identify user intent and route customer utterances to appropriate chatbot flows.",
                    "Trained and maintained Azure CLU models using customer utterances, supporting intent recognition and conversational routing for IT support scenarios.",
                    "Integrated ServiceNow Incident/Ticketing, Knowledge Base and Interactions with Genesys Live Chat, enabling automated support workflows and bot-to-agent escalation.",
                    "Developed and maintained REST APIs and backend services, including MongoDB query optimization and Redis caching for session and frequently accessed data.",
                    "Implemented structured logging, environment-specific configuration and secret management to improve application traceability and operational support.",
                    "Collaborated with client product owners to translate support requirements into conversational flows and used containment and escalation metrics to identify chatbot improvement areas.",
                    "Supported production troubleshooting and root-cause analysis, resolving live defects and implementing permanent fixes.",
                ],
            },
        ],
        "highlights": [],
    },
    {
        "employer": "Wipro",
        "role": "Associate Software Engineer",
        "start": "2019-06",
        "end": "2020-06",
        "summary": (
            "Enterprise Asset Management - AIRFORCE INDIA (IAF-Maximo) & Core Integration Stream (IBF-AIC)."
        ),
        "highlights": [
            "Supported IBM Maximo Enterprise Asset Management (EAM) platform using Java-based application components and SQL/MySQL databases for large-scale asset tracking and maintenance operations.",
            "Optimized SQL queries and database operations, troubleshooting performance issues, resolving data integrity problems and improving reliability of backend data processing.",
            "Contributed to Maximo application development and maintenance, including defect resolution, application enhancements and backend troubleshooting across enterprise workflows.",
            "Supported system integration validation across Maximo and connected enterprise applications, analyzing data flows, identifying integration defects and validating fixes.",
            "Participated in Agile development sprints, collaborating with development and QA teams on requirements, implementation, testing, defect resolution and production-ready releases.",
        ],
    },
]

# WHY: empty, not invented. The resume has no standalone project section, so the two client
# engagements above carry the project detail. Fabricating projects would be the worst possible
# failure mode for a portfolio whose entire value is that its claims are true.
profile["projects"] = []

profile["education"] = [
    {
        "degree": "B.Tech, Computer Science & Engineering",
        "institution": "Chandigarh University, Mohali",
        "start": "2015",
        "end": "2019",
    },
]

profile["certifications"] = [
    {"name": "Microsoft Certified: Azure Fundamentals (AZ-900)", "issuer": "Microsoft", "source": CERT_SRC},
    {"name": "Microsoft Certified: Azure AI Fundamentals (AI-901)", "issuer": "Microsoft", "source": CERT_SRC},
    {"name": "Claude Certified Architect - Foundations", "issuer": "Anthropic", "source": CERT_SRC},
    {"name": "Claude Certified Developer - Foundations", "issuer": "Anthropic", "source": CERT_SRC},
    {"name": "Tech 4.0 Certified Professional", "issuer": "Tata Consultancy Services",
     "note": "TCS internal competency framework", "source": CERT_SRC},
    {"name": "Certification training in Linux Administration and Networking Fundamentals", "source": CERT_SRC},
    {"name": "Multiple TCS Digital Awards and client appreciation certificates for project delivery",
     "issuer": "Tata Consultancy Services", "source": CERT_SRC},
]

profile["contact"] = {
    # WHY: email and phone render as click-to-reveal so they stay usable by a human without
    # sitting in crawlable HTML. LinkedIn/GitHub stay ordinary links: they are public profiles
    # whose whole purpose is to be indexed.
    "email": {"value": "ravi1996.r@gmail.com", "public": True, "render": "reveal"},
    "phone": {"value": "+919873393885", "public": True, "render": "reveal"},
    "linkedin": {"value": "https://linkedin.com/in/ravi-ranjan-prasad", "public": True, "render": "link"},
    "github": {"value": "https://github.com/ravi1996r", "public": True, "render": "link"},
    "location": "Faridabad, Delhi NCR, India",
}

profile["resume"] = {
    "available": True,
    "path": "/resume/Ravi-Ranjan-Prasad-Resume.pdf",
    "label": "Download resume (PDF)",
}

profile["chatbot1"] = {
    "voice": "third",
    "persona_note": (
        "Ravi's AI assistant. Professional but personable. Speaks about Ravi in the third person "
        "by default because recruiters and visitors read these answers, never as 'I'."
    ),
    "refusal_phrase": "That isn't in Ravi's resume or projects.",
    "starter_questions": [
        "What has he built with Gen-AI?",
        "Summarize his experience in 30 seconds",
        "Which skills fit a backend role?",
        "What RAG work has he done?",
        "What is his current role and project?",
    ],
}

profile["sections"] = [
    {"id": "hero", "title": "Welcome", "enabled": True, "camera_preset": "hero"},
    {"id": "about", "title": "About", "enabled": True, "camera_preset": "about"},
    {"id": "experience", "title": "Experience", "enabled": True, "camera_preset": "experience"},
    {"id": "projects", "title": "Projects", "enabled": True, "camera_preset": "projects", "todo": True},
    {"id": "skills", "title": "Skills", "enabled": True, "camera_preset": "skills"},
    {"id": "education", "title": "Education", "enabled": True, "camera_preset": "education"},
    {"id": "achievements", "title": "Certifications", "enabled": True, "camera_preset": "achievements"},
    {"id": "contact", "title": "Contact", "enabled": True, "camera_preset": "contact"},
]

profile["source_register"] = [
    {"field": "identity.full_name", "source_file": RESUME, "locator": "p.1 header"},
    {"field": "identity.headline", "source_file": RESUME, "locator": "p.1 header, line 2"},
    {"field": "identity.location", "source_file": RESUME, "locator": "p.1 contact line"},
    {"field": "identity.tagline", "source_file": "(derived)", "locator": "n/a",
     "note": "Short restatement of the resume summary used as the hero line. No new facts."},
    {"field": "summary", "source_file": RESUME, "locator": "p.1 PROFESSIONAL SUMMARY"},
    {"field": "skills", "source_file": RESUME, "locator": "p.1 TECHNICAL SKILLS"},
    {"field": "experience[0]", "source_file": RESUME,
     "locator": "p.1 PROFESSIONAL EXPERIENCE, Oct2021-Present"},
    {"field": "experience[0].clients[0]", "source_file": RESUME,
     "locator": "p.1 Client: Exxon Mobil Corporation - Enterprise AI Assistant (ITChat), Sep2024-Present"},
    {"field": "experience[0].clients[1]", "source_file": RESUME,
     "locator": "p.2 Client: Shell plc - IT Support Chatbot (Sam), Oct2021-Sep2024"},
    {"field": "experience[1]", "source_file": RESUME,
     "locator": "p.2 Associate Software Engineer, Wipro, Jun2019-Jun2020"},
    {"field": "education", "source_file": RESUME, "locator": "p.2 EDUCATION"},
    {"field": "certifications", "source_file": RESUME, "locator": "p.2 CERTIFICATIONS & ACHIEVEMENTS"},
    {"field": "contact.email", "source_file": RESUME, "locator": "p.1 contact line"},
    {"field": "contact.phone", "source_file": RESUME, "locator": "p.1 contact line"},
    {"field": "contact.linkedin", "source_file": RESUME, "locator": "p.1 contact line"},
    {"field": "contact.github", "source_file": RESUME, "locator": "p.1 contact line"},
    {"field": "projects", "source_file": "(absent)", "locator": "n/a",
     "note": ("The resume contains no standalone project section. Client engagements are modelled "
              "under experience[].clients[] instead. content/projects/ stays empty until project "
              "READMEs are supplied. See docs/content-todos.md.")},
]

OUT.write_text(json.dumps(profile, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
print(f"wrote {OUT}")
print("sections:", len(profile["sections"]),
      "skills:", len(profile["skills"]),
      "experience:", len(profile["experience"]),
      "certs:", len(profile["certifications"]))
