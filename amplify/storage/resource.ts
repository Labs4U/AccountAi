import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'AccountAIDocuments',
  access: (allow) => ({
    // FIX: Added 'private/' prefix before the entity_id
    'private/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete'])
    ]
  })
});