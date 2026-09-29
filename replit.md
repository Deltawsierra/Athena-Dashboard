# Athena AI - Cybersecurity Intelligence Platform (Desktop Edition)

## Overview
Athena AI Desktop is a futuristic, JARVIS-inspired, comprehensive cybersecurity platform designed to run entirely offline as a standalone desktop application. Its core purpose is to provide real-time threat monitoring and analysis, CVE classification, automated penetration testing, security audit logging, compliance tracking, and robust admin controls. The project aims to deliver a powerful, offline-first cybersecurity solution with a highly interactive and visually engaging user experience.

## User Preferences
When making changes:
1. Follow existing code patterns
2. Test animations on multiple screen sizes
3. Run architect review for significant changes
4. Update this documentation
5. Ensure all tests pass

## System Architecture

### Core Design
The platform transitioned from a web application to a desktop application using **Electron**, ensuring complete offline functionality. Data storage migrated from cloud PostgreSQL to a local **SQLite** database, managed by **Drizzle ORM**. The application uses a session-based authentication system suitable for a desktop environment. The UI/UX emphasizes a modern, visually engaging experience with advanced, performant animations, glass morphism design elements, and an intuitive navigation structure.

### Technical Implementations
- **Desktop Framework**: Electron for cross-platform compatibility.
- **Frontend**: React 18 with TypeScript, Vite, Wouter for routing, Shadcn/UI for components, Tailwind CSS for styling, Recharts for data visualization, and React Query for state management.
- **Backend**: An embedded Express server handles API requests and interacts with the SQLite database.
- **Animation System**: Utilizes Framer Motion for advanced spring animations, Lenis for smooth scrolling, and custom CSS utilities for GPU-accelerated effects, focusing on performance, accessibility, and natural motion.
- **Admin Features**: Expanded with dedicated pages for AI Control Panel (emergency kill switch, override), AI Chat Interface, Deletion Management, and ML Classifier management.
- **Database Schema** (`shared/schema.ts`, sixteen tables): `users`, `clients`, `sites`, `tests`, `findings`, `findingSightings`, `findingChecks`, `retestWatches`, `documents`, `activityLogs`, `aiHealthMetrics`, `aiControlSettings`, `connectionSettings`, `aiChatMessages`, `classifiers`, and `apiKeys`.

### Key Features
- **Dashboard**: Real-time threat monitoring with animated ticker tape, metric cards, and interactive charts.
- **CVE Classifier**: Automated analysis and severity classification of CVEs.
- **Pentest Scanner**: Automated penetration testing with configurable scans and real-time progress.
- **Admin Panel**: User management, role assignment, system configuration, AI health monitoring, and centralized deletion.
- **AI Features**: AI Chat interface, AI Control Panel for system overrides, and ML Classifier management for threat detection.
- **Clients & Tests**: Comprehensive management of client information, security test tracking, and document handling.
- **Audit Logs**: Detailed security event logging for compliance and analysis.

## External Dependencies
- **Electron**: For building cross-platform desktop applications.
- **SQLite**: Embedded database for local, offline data storage.
- **electron-builder**: For creating multi-platform installers.
- **React 18**: Frontend JavaScript library.
- **Vite**: Frontend build tool.
- **Wouter**: Lightweight routing library for React.
- **Framer Motion**: Animation library for React.
- **Lenis**: Smooth scrolling utility.
- **Shadcn/UI**: Component library.
- **Tailwind CSS**: Utility-first CSS framework.
- **Recharts**: Charting library for React.
- **React Query**: For server state management.
- **Express**: Backend web framework (embedded).
- **Drizzle ORM**: Type-safe ORM for database interactions.
- **react-intersection-observer**: For viewport-based animations.