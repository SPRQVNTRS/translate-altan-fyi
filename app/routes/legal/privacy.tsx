import { H1, H2, P } from '#app/components/typography';
import PublicWrapper from '#app/components/public-wrapper';
import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => {
  return [{ title: 'Privacy Policy' }];
};

export default function Privacy() {
  return (
    <PublicWrapper>
      <article className="prose prose-zinc dark:prose-invert max-w-none">
            <H1 variant="default" className="mb-8">Privacy Policy</H1>
            
            <P variant="subtle" className="mb-8">Last updated: January 27, 2025</P>
            
            <section className="mb-8">
              <H2 variant="default">1. Information We Collect</H2>
              <P>We collect information you provide directly to us, such as when you create an account, update your profile, use our services, or contact us for support.</P>
              <P className="mt-4">The types of information we may collect include:</P>
              <ul className="mt-4">
                <li>Name, email address, and password</li>
                <li>Profile information and preferences</li>
                <li>Payment information (processed securely through third-party providers)</li>
                <li>Communications between you and our platform</li>
              </ul>
            </section>

            <section className="mb-8">
              <H2 variant="default">2. How We Use Your Information</H2>
              <P>We use the information we collect to:</P>
              <ul className="mt-4">
                <li>Provide, maintain, and improve our services</li>
                <li>Process transactions and send related information</li>
                <li>Send technical notices, updates, security alerts, and support messages</li>
                <li>Respond to your comments, questions, and customer service requests</li>
                <li>Monitor and analyze trends, usage, and activities</li>
              </ul>
            </section>

            <section className="mb-8">
              <H2 variant="default">3. Information Sharing</H2>
              <P>We do not sell, trade, or rent your personal information to third parties. We may share your information in the following situations:</P>
              <ul className="mt-4">
                <li>With your consent or at your direction</li>
                <li>To comply with legal obligations</li>
                <li>To protect our rights, privacy, safety, or property</li>
                <li>In connection with a merger, sale, or asset transfer</li>
              </ul>
            </section>

            <section className="mb-8">
              <H2 variant="default">4. Data Security</H2>
              <P>We implement appropriate technical and organizational measures to protect the security of your personal information. However, no method of transmission over the Internet or electronic storage is 100% secure.</P>
            </section>

            <section className="mb-8">
              <H2 variant="default">5. Your Rights</H2>
              <P>You have the right to:</P>
              <ul className="mt-4">
                <li>Access and receive a copy of your personal data</li>
                <li>Correct or update inaccurate information</li>
                <li>Request deletion of your personal data</li>
                <li>Object to or restrict processing of your data</li>
                <li>Withdraw consent at any time</li>
              </ul>
            </section>

            <section className="mb-8">
              <H2 variant="default">6. Cookies</H2>
              <P>We use cookies and similar tracking technologies to track activity on our service and hold certain information. You can control cookies through your browser settings.</P>
            </section>

            <section className="mb-8">
              <H2 variant="default">7. Contact Us</H2>
              <P>If you have any questions about this Privacy Policy, please contact us at privacy@example.com.</P>
            </section>
      </article>
    </PublicWrapper>
  );
}
