import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { Amplify } from 'aws-amplify';
import outputs from '../amplify_outputs.json';

// 1. Load the generated outputs (Auth, DynamoDB)
Amplify.configure(outputs);

// 2. Inject the manual configuration for your specific S3 bucket
const existingConfig = Amplify.getConfig();
Amplify.configure({
  ...existingConfig,
  Storage: {
    S3: {
      bucket: 'account-ai-bh', // Pointing React to your specific bucket
      region: 'us-east-1',     // Ensure this matches where your bucket is deployed
    }
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);