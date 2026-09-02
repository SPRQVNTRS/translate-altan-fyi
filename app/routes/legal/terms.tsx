import { H1, H2, P } from '#app/components/typography';
import PublicWrapper from '#app/components/public-wrapper';
import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => {
  return [{ title: 'Terms of Service' }];
};

export default function Terms() {
  return (
    <PublicWrapper>
      <article className="prose prose-zinc dark:prose-invert max-w-none">
            <H1 variant="default" className="mb-8">Terms of Service</H1>
            
            <P variant="subtle" className="mb-8">Last updated: January 27, 2025</P>
            
            <section className="mb-8">
              <H2 variant="default">1. Acceptance of Terms</H2>
              <P>By accessing and using this service, you accept and agree to be bound by the terms and provision of this agreement. If you do not agree to abide by the above, please do not use this service.</P>
            </section>

            <section className="mb-8">
              <H2 variant="default">2. Use License</H2>
              <P>Permission is granted to temporarily download one copy of the materials on our application for personal, non-commercial transitory viewing only. This is the grant of a license, not a transfer of title, and under this license you may not:</P>
              <ul className="mt-4">
                <li>modify or copy the materials;</li>
                <li>use the materials for any commercial purpose or for any public display;</li>
                <li>attempt to reverse engineer any software contained on our application;</li>
                <li>remove any copyright or other proprietary notations from the materials.</li>
              </ul>
            </section>

            <section className="mb-8">
              <H2 variant="default">3. Privacy Policy</H2>
              <P>Your use of our application is also governed by our Privacy Policy. Please review our Privacy Policy, which also governs the Site and informs users of our data collection practices.</P>
            </section>

            <section className="mb-8">
              <H2 variant="default">4. Prohibited Uses</H2>
              <P>In addition to other prohibitions as set forth in the Terms of Service, you are prohibited from using the application or its content:</P>
              <ul className="mt-4">
                <li>for any unlawful purpose or to solicit others to perform or participate in any unlawful acts;</li>
                <li>to infringe upon or violate our intellectual property rights or the intellectual property rights of others;</li>
                <li>to harass, abuse, insult, harm, defame, slander, disparage, intimidate, or discriminate;</li>
                <li>to submit false or misleading information;</li>
                <li>to upload or transmit viruses or any other type of malicious code.</li>
              </ul>
            </section>

            <section className="mb-8">
              <H2 variant="default">5. Termination</H2>
              <P>We may terminate or suspend your access to our Service immediately, without prior notice or liability, for any reason whatsoever, including without limitation if you breach the Terms.</P>
            </section>

            <section className="mb-8">
              <H2 variant="default">6. Contact Information</H2>
              <P>Questions about the Terms of Service should be sent to us at legal@example.com.</P>
            </section>
      </article>
    </PublicWrapper>
  );
}
