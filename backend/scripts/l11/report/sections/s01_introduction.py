from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, Spacer, PageBreak, Image as RLImage
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from PIL import Image
import os
from typing import List
from reportlab.platypus import HRFlowable
from typing import List

from utils.html_builder import Html

class IntroductionSection:
    """Handles generation of introduction section in PDF reports."""
    
    RESOURCE_DIR = os.path.join(os.path.dirname(__file__), 'resources')
    
    def __init__(self, project_display_name: str, report_level: str = "L11"):
        self.project_display_name = project_display_name
        self.report_level = report_level
        self.styles = getSampleStyleSheet()
        self.MARGIN = 1 * inch  # One inch margin for intro pages
        
        # Create custom styles for the introduction
        self.title_style = ParagraphStyle(
            'IntroTitle',
            parent=self.styles['Heading1'],
            fontSize=24,
            spaceAfter=0.05 * inch,
            alignment=1  # CENTER
        )
        self.section_style = ParagraphStyle(
            'IntroSection',
            parent=self.styles['Heading2'],
            spaceBefore=0.1*inch,
            leftIndent=0.3*inch,
            rightIndent=0.3*inch,
            fontSize=14,
            alignment=1,  # CENTER
            textColor=colors.blue
        )
        self.subtitle_style = ParagraphStyle(
            'IntroSubtitle2',
            parent=self.styles['Heading2'],
            spaceBefore=0.1*inch,
            leftIndent=0.3*inch,
            rightIndent=0.3*inch,
            fontSize=12,
            alignment=1,
        )
        self.normal_style = ParagraphStyle(
            'IntroNormal',
            parent=self.styles['Normal'],
            leftIndent=0.3*inch,
            rightIndent=0.3*inch,
            fontSize=10,
            alignment=1  # CENTER
        )
        self.normal_left_style = ParagraphStyle(
            'IntroNormalLeft',
            parent=self.styles['Normal'],
            leftIndent=0.3*inch,
            rightIndent=0.3*inch,
            fontSize=10,
            alignment=0  # LEFT
        )

    def add_image_to_story(self, story: List, image_name: str, max_height: float = 4*inch) -> None:
        """Add an image to the story if it exists, otherwise add a placeholder."""
        image_path = os.path.join(self.RESOURCE_DIR, image_name)
        if os.path.exists(image_path):
            try:
                pil_img = Image.open(image_path)
                width = letter[0] - 2*self.MARGIN
                height = (pil_img.size[1] * width) / pil_img.size[0]
                # Scale down if too tall
                if height > max_height:
                    height = max_height
                    width = (pil_img.size[0] * height) / pil_img.size[1]
                img = RLImage(image_path, width=width, height=height)
                story.append(img)
            except Exception as e:
                story.append(Paragraph(f"[{image_name} - Image not found]", self.normal_style))
        else:
            story.append(Paragraph(f"[{image_name}]", self.normal_style))

    def add_to_story(self, story: List) -> None:
        """Add introduction section to the story."""
        # Page 1: B200 L11/L10 Solution and Validation Report
        story.append(Paragraph(Html.anchor('introduction'), self.styles['Normal']))
        story.append(Paragraph(self.project_display_name, self.title_style))
        story.append(Paragraph(f"{self.report_level} Solution and Validation Report", self.title_style))
        story.append(HRFlowable(width="100%", thickness=1, color=colors.black, spaceBefore=0.2*inch, spaceAfter=0.2*inch))
        self.add_image_to_story(story, 'hpc_team.png', 0.22*inch)
        story.append(Spacer(1, 0.1*inch))
        
        intro_text = """Supermicro's AI and HPC team (part of Supermicro Solution and Integration Center) is an elite team of software and hardware engineers. We generate and publish state-of-the-art benchmarks showcasing the performance of Supermicro's wide array of Super Servers. We also work with the industry leading AI and HPC partners to generate the latest and greatest performance data."""
        story.append(Paragraph(intro_text, self.normal_left_style))
        story.append(HRFlowable(width="20%", thickness=1, color=colors.black, spaceBefore=0.2*inch, spaceAfter=0.2*inch))

        story.append(Paragraph("Here are some benchmarks we have conducted:", self.normal_style))
        story.append(Spacer(1, 0.1*inch))

        self.add_image_to_story(story, 'benchmarks.png', 2.23*inch)
        story.append(HRFlowable(width="20%", thickness=1, color=colors.black, spaceBefore=0.2*inch, spaceAfter=0.2*inch))

        story.append(Paragraph("Here is a list of other solutions that we offer:", self.normal_style))

        self.add_image_to_story(story, 'solutions.png', 2.12*inch)
        story.append(HRFlowable(width="20%", thickness=1, color=colors.black, spaceBefore=0.2*inch, spaceAfter=0.2*inch))
        
        story.append(Paragraph("For more information about our services, please visit:", self.normal_style))
        story.append(Paragraph(
            Html.link('http://solution.supermicro.com/', 
                     Html.bold('Supermicro Solution and Integration Center')),
            self.section_style))
        story.append(Paragraph("For an in-depth view of our benchmarks, please visit our blog:", self.normal_style))
        story.append(Paragraph(
            Html.link('http://aihpc.supermicro.com/', 
                     Html.bold('AI and HPC Benchmarks')),
            self.section_style))
        story.append(Paragraph(Html.colored_text(
            'NOTE: Both pages require company network to access', 'red'), self.normal_style))

        # Page 2: Cluster Showcase during L11/L10 Testing
        story.append(PageBreak())
        story.append(Spacer(1, 0.5*inch))
        story.append(Paragraph(f"Cluster Showcase during {self.report_level} Testing", self.subtitle_style))

        cluster_text = f"""SMC HPC cluster aims to provide high-performance, high-efficiency server, storage technology and Green Computing.
    The image below is a showcase of cluster during {self.report_level} testing. Followed by the hardware information and benchmark results. For more information about this product, please visit our official website: {Html.link('https://www.supermicro.com/', 'https://www.supermicro.com/', color='blue')}"""
        story.append(Paragraph(cluster_text, self.normal_left_style))
        story.append(Spacer(1, 0.3*inch))

        self.add_image_to_story(story, 'cluster.png', 2.18*inch)

        story.append(Spacer(1, 0.3*inch))
        story.append(Paragraph("What We Provide", ParagraphStyle(
            'IntroSectionLeftGray',
            parent=self.section_style,
            alignment=0,  # LEFT
            textColor=colors.gray
        )))
        story.append(Spacer(1, 0.2*inch))

        story.append(Paragraph(r"We provide rack/cluster wide integration testing services. Our test items were designed to ensure the overall quality and integrity of the whole rack/cluster, and achieve 100% customer satisfaction with the Supermicro products and solutions.", self.normal_left_style))
        story.append(Spacer(1, 0.05*inch))
        story.append(Paragraph(r"The Supermicro integration test aims to expose any issue within the system and network so that we can eliminate the issue and improve the availability, stability and performance of the rack/cluster.", self.normal_left_style))
        story.append(Spacer(1, 0.05*inch))
        story.append(Paragraph(rf"Our {self.report_level} test program leverages tools in AI, HPC, Big Data, Database, Virtualization/Cloud, File System, and Network, which is key for us to deliver high-quality, customizable rack/cluster solutions to our valued customers.", self.normal_left_style))
        story.append(PageBreak())